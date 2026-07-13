import { URL } from "url";
import { v4 as uuidv4 } from "uuid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, MCPClient } from "../../openai/types/chat";
import { McpCliProps } from "./types";
import {
  addConnectionToSession,
  updateConnectionStatus,
  McpConnectionEntry,
  McpTransportKind,
} from "./session-config";
import { loadClientsFromSession } from "./load-clients";
import { AvailableServiceEntry, standardMcpConfigPath, standardMcpConfigPaths } from "./standard-config";
import { loadAvailableCatalog, availableCatalogPath } from "./catalog";
import { isLocalMode } from "./runtime-mode";
import { buildMcpOAuthProvider } from "./oauth/provider-factory";
import { UserAuthenticationsTokenStore, TokenStoreUser } from "@reactory/server-core/authentication/oauth";

// ── Result envelope used by every handler ───────────────────────────────────
interface HandlerResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

const ok = <T,>(data: T): HandlerResult<T> => ({ success: true, data });
const fail = (error: string): HandlerResult => ({ success: false, error });

// ── Catalog helpers ─────────────────────────────────────────────────────────
// The catalog loaders live in ./catalog (shared with the OAuth callback route).
// `AvailableServiceEntry`, `resolveEnvTemplate` etc. live in ./standard-config.

const isUrlInCatalog = (candidateUrl: string, catalog: AvailableServiceEntry[]): boolean => {
  try {
    const candidate = new URL(candidateUrl);
    return catalog.some((svc) => {
      if (!svc.url) return false;
      try {
        const allowed = new URL(svc.url);
        return allowed.origin === candidate.origin && candidate.pathname.startsWith(allowed.pathname);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

const findClient = (state: ChatState, id: string): MCPClient | undefined =>
  (state.mcpClients ?? []).find((c) => c.id === id.trim());

const buildAuthHeaders = (state: ChatState): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (state.authToken) headers["Authorization"] = `Bearer ${state.authToken}`;
  const anyState = state as unknown as { clientKey?: string; clientSecret?: string };
  if (anyState.clientKey) headers["x-client-key"] = anyState.clientKey;
  if (anyState.clientSecret) headers["x-client-pwd"] = anyState.clientSecret;
  return headers;
};

/**
 * Whether stdio transports are permitted in this runtime.
 *
 * Always allowed in local mode — the electron desktop shell, an explicit local
 * install (`IS_DESKTOP_INSTALL`/`IS_LOCAL_MODE`), where the MCP subprocess runs
 * on the user's own machine. On a cloud/server deployment it must be enabled
 * explicitly via `REACTORY_MCP_STDIO_ENABLED=true` so operators opt in to the
 * process-spawning surface.
 */
const isStdioAllowed = (): boolean =>
  isLocalMode() || process.env.REACTORY_MCP_STDIO_ENABLED === "true";

const pickActiveTransport = (mcpClient: MCPClient):
  | { kind: "http"; transport: StreamableHTTPClientTransport }
  | { kind: "stdio"; transport: StdioClientTransport }
  | null => {
  if (mcpClient.transports?.http) return { kind: "http", transport: mcpClient.transports.http };
  if (mcpClient.transports?.stdio) return { kind: "stdio", transport: mcpClient.transports.stdio };
  return null;
};

// Turn a raw MCP SDK transport error into an actionable, user-facing message.
// The original message is preserved in the fallback so debugging isn't lost.
const classifyMcpError = (
  err: unknown,
  ctx: { kind: "http" | "stdio"; url?: string; command?: string; id: string }
): string => {
  const raw = err instanceof Error ? err.message : String(err);
  const endpoint =
    ctx.kind === "http" ? ctx.url ?? "(unknown url)" : ctx.command ?? `(stdio client ${ctx.id})`;

  if (/Unexpected content type:\s*text\/html/i.test(raw)) {
    return (
      `MCP endpoint at ${endpoint} returned HTML instead of a Streamable-HTTP response. ` +
      `The URL probably points to a web page or login form rather than the MCP endpoint ` +
      `(MCP servers respond with application/json or text/event-stream). ` +
      `Verify the exact path — many implementations expose /mcp, /sse, or /rpc.`
    );
  }
  if (/Unexpected content type/i.test(raw)) {
    return `MCP endpoint at ${endpoint} returned an unsupported content type. Underlying: ${raw}`;
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `MCP server at ${endpoint} refused the connection. Is the server running on the expected host/port?`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `MCP server host for ${endpoint} could not be resolved via DNS. Check the hostname.`;
  }
  if (/ETIMEDOUT|timed? out/i.test(raw)) {
    return `MCP connection to ${endpoint} timed out. The server may be slow or unreachable.`;
  }
  if (/\b401\b|Unauthorized/i.test(raw)) {
    return (
      `MCP server at ${endpoint} rejected credentials (401). ` +
      `If the host is not listed in available.yaml, Reactory does not forward auth headers. ` +
      `Add it to the catalog or provide a pre-authenticated URL.`
    );
  }
  if (/\b403\b|Forbidden/i.test(raw)) {
    return `MCP server at ${endpoint} returned 403 Forbidden. The current user lacks access to this endpoint.`;
  }
  if (/\b404\b|Not Found/i.test(raw)) {
    return `MCP endpoint ${endpoint} returned 404. Verify the exact path (e.g. /mcp, /sse).`;
  }
  if (/\b5\d{2}\b/.test(raw)) {
    return `MCP server at ${endpoint} returned a 5xx server error. Retry shortly; check the remote server logs. Underlying: ${raw}`;
  }
  if (/fetch failed/i.test(raw)) {
    return `MCP transport could not reach ${endpoint} (network failure). Underlying: ${raw}`;
  }
  return `MCP transport error for ${endpoint}: ${raw}`;
};

// ── Handlers (each returns HandlerResult) ───────────────────────────────────

const getCapabilities = async (
  id: string | undefined,
  state: ChatState
): Promise<HandlerResult> => {
  const clients = id ? (findClient(state, id) ? [findClient(state, id)!] : []) : state.mcpClients ?? [];
  if (id && clients.length === 0) return fail(`No client found with id: ${id}`);
  const data = clients.map((c) => ({
    id: c.id,
    name: c.name,
    capabilities: c.client.getServerCapabilities(),
  }));
  return ok(data);
};

const getPrompts = async (
  id: string | undefined,
  state: ChatState
): Promise<HandlerResult> => {
  const clients = id ? (findClient(state, id) ? [findClient(state, id)!] : []) : state.mcpClients ?? [];
  if (id && clients.length === 0) return fail(`No client found with id: ${id}`);
  const data = await Promise.all(
    clients.map(async (c) => {
      try {
        return { id: c.id, name: c.name, prompts: await c.client.listPrompts() };
      } catch (err) {
        return { id: c.id, name: c.name, error: (err as Error).message };
      }
    })
  );
  return ok(data);
};

const getResources = async (
  id: string | undefined,
  state: ChatState
): Promise<HandlerResult> => {
  const clients = id ? (findClient(state, id) ? [findClient(state, id)!] : []) : state.mcpClients ?? [];
  if (id && clients.length === 0) return fail(`No client found with id: ${id}`);
  const data = await Promise.all(
    clients.map(async (c) => {
      try {
        return { id: c.id, name: c.name, resources: await c.client.listResources() };
      } catch (err) {
        return { id: c.id, name: c.name, error: (err as Error).message };
      }
    })
  );
  return ok(data);
};

const getTools = async (
  id: string | undefined,
  format: "json" | "text",
  state: ChatState
): Promise<HandlerResult> => {
  const clients = state.mcpClients ?? [];
  if (clients.length === 0) return fail("No MCP clients registered — use add-connection first.");

  const client = id ? findClient(state, id) : clients[0];
  if (!client) return fail(`No client found with id: ${id}`);

  const tools = await client.client.listTools();

  if (format === "json") return ok(tools);

  const text = (tools.tools ?? [])
    .map((t: { name: string; description?: string }) => `Tool: ${t.name}\nDescription: ${t.description ?? ""}\n`)
    .join("\n");
  return ok(`Tools for client ${client.name} (${client.id}):\n\n${text || "(no tools)"}`);
};

const addHttpConnection = (
  id: string,
  url: string,
  state: ChatState,
  catalog: AvailableServiceEntry[],
  catalogEntry?: AvailableServiceEntry
): HandlerResult => {
  const baseUrl = url.endsWith("/") ? url : `${url}/`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return fail(
      `add-connection failed: "${url}" is not a valid URL. Provide an absolute http:// or https:// URL.`
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return fail(
      `add-connection failed: URL "${url}" must use the http:// or https:// scheme (got ${parsedUrl.protocol}).`
    );
  }

  const inCatalog = isUrlInCatalog(url, catalog);
  const client = new Client({ name: id, version: "1.0.0" });
  const connectionId = uuidv4();

  // Static headers declared on the catalog entry (e.g. a token in ~/.reactor/mcp.yaml)
  // are always applied; forwarded auth headers are layered on only for catalog hosts.
  const staticHeaders = catalogEntry?.headers ?? {};
  const headers: Record<string, string> = {
    ...staticHeaders,
    ...(inCatalog ? buildAuthHeaders(state) : {}),
  };
  const requestInit: RequestInit = { credentials: "include", headers };

  // oauth-typed services get an SDK OAuthClientProvider (tokens persisted to the
  // shared encrypted store); everything else keeps the static-header path.
  const authProvider = buildMcpOAuthProvider(state, id, catalogEntry?.auth);
  const httpTransport = new StreamableHTTPClientTransport(
    parsedUrl,
    authProvider ? { requestInit, authProvider } : { requestInit }
  );
  const description = catalogEntry?.description || `MCP Client for ${id}`;

  state.mcpClients!.push({
    id: connectionId,
    client,
    name: id,
    description,
    transports: { http: httpTransport },
    url,
    authProvider: authProvider ?? undefined,
  });

  if (state.sessionFolder) {
    addConnectionToSession(state.sessionFolder, {
      id: connectionId,
      serverName: id,
      description,
      url,
      transport: "http",
      headers: Object.keys(staticHeaders).length ? staticHeaders : undefined,
      auth: catalogEntry?.auth,
      status: "inactive",
    });
  }

  return ok({
    id: connectionId,
    name: id,
    transport: "http",
    url,
    oauth: !!authProvider,
    credentialsForwarded: inCatalog,
    message: authProvider
      ? `Added http connection ${id} with url ${url} (OAuth — run connect; you'll be prompted to authorize).`
      : inCatalog
      ? `Added http connection ${id} with url ${url} (credentials forwarded — host in available.yaml).`
      : `Added http connection ${id} with url ${url} (no credentials forwarded — host not in available.yaml).`,
  });
};

const addStdioConnection = (
  id: string,
  state: ChatState,
  catalog: AvailableServiceEntry[]
): HandlerResult => {
  if (!isStdioAllowed()) {
    return fail(
      "stdio transport is disabled in this runtime. It is enabled automatically in local mode " +
      "(IS_DESKTOP_INSTALL=true / IS_LOCAL_MODE=true, or the electron shell); on server deployments " +
      "set REACTORY_MCP_STDIO_ENABLED=true to opt in."
    );
  }

  const catalogEntry = catalog.find((svc) => svc.id === id);
  if (!catalogEntry) {
    return fail(
      `stdio connections must reference a service id defined in available.yaml or ~/.reactor/mcp.yaml. ` +
      `No catalog entry found for id "${id}". Use command="available" to list options.`
    );
  }
  if (catalogEntry.transport !== "stdio") {
    return fail(
      `Catalog entry "${id}" declares transport="${catalogEntry.transport}", not stdio. ` +
      `Call add-connection without transport=stdio to use that service.`
    );
  }
  if (!catalogEntry.command) {
    return fail(`Catalog entry "${id}" is missing a "command" field required for stdio transport.`);
  }

  const client = new Client({ name: id, version: "1.0.0" });
  const connectionId = uuidv4();

  const stdioTransport = new StdioClientTransport({
    command: catalogEntry.command,
    args: catalogEntry.args ?? [],
    env: catalogEntry.env,
    cwd: catalogEntry.cwd,
  });

  state.mcpClients!.push({
    id: connectionId,
    client,
    name: id,
    description: catalogEntry.description || `MCP Client for ${id}`,
    transports: { stdio: stdioTransport },
    command: catalogEntry.command,
  });

  if (state.sessionFolder) {
    addConnectionToSession(state.sessionFolder, {
      id: connectionId,
      serverName: id,
      description: catalogEntry.description || `MCP Client for ${id}`,
      transport: "stdio",
      command: catalogEntry.command,
      args: catalogEntry.args,
      env: catalogEntry.env,
      cwd: catalogEntry.cwd,
      status: "inactive",
    });
  }

  return ok({
    id: connectionId,
    name: id,
    transport: "stdio",
    command: catalogEntry.command,
    message: `Added stdio connection ${id} (command resolved from catalog).`,
  });
};

const addConnection = async (
  id: string,
  url: string | undefined,
  transport: McpTransportKind,
  state: ChatState
): Promise<HandlerResult> => {
  if (!state.mcpClients) state.mcpClients = [];

  const existing = state.mcpClients.find((c) => c.name === id);
  if (existing) {
    return ok({ id: existing.id, reused: true, message: `Connection ${id} already registered.` });
  }

  const catalog = loadAvailableCatalog();
  const catalogEntry = catalog.find((svc) => svc.id === id);
  const resolved: McpTransportKind = transport === "sse" ? "http" : transport;

  if (resolved === "stdio") {
    return addStdioConnection(id, state, catalog);
  }

  // http: an explicit url wins; otherwise fall back to the catalog entry's url so
  // catalog / ~/.reactor/mcp.yaml services can be connected by id alone.
  const effectiveUrl = url ?? catalogEntry?.url;
  if (!effectiveUrl) {
    return fail(
      "http transport requires a url (pass url=..., or reference a catalog id that declares one)."
    );
  }
  return addHttpConnection(id, effectiveUrl, state, catalog, catalogEntry);
};

const callTool = async (
  id: string,
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  toolParams: string[] | undefined,
  state: ChatState
): Promise<HandlerResult> => {
  const client = findClient(state, id);
  if (!client) return fail(`No client found with id: ${id}`);

  const displayName = client.name ?? id;

  let tools: { tools?: Array<{ name: string }> };
  try {
    tools = await client.client.listTools();
  } catch (err) {
    return fail(
      `call-tool failed: could not list tools for client "${displayName}". ` +
        `Is the transport connected? (command="connect", id="${id}"). ` +
        `Underlying: ${(err as Error).message}`
    );
  }

  const available = (tools.tools ?? []).map((t) => t.name);
  if (!available.includes(toolName)) {
    const hint = available.length
      ? `Available tools: ${available.slice(0, 10).join(", ")}${available.length > 10 ? ", …" : ""}.`
      : "The connected server exposes no tools.";
    return fail(`No tool named "${toolName}" on client "${displayName}". ${hint}`);
  }

  const args: Record<string, unknown> =
    toolArgs && typeof toolArgs === "object"
      ? toolArgs
      : toolParams && toolParams.length > 0
      ? { args: toolParams }
      : {};

  try {
    const result = await client.client.callTool({ name: toolName, arguments: args });
    return ok(result);
  } catch (err) {
    return fail(
      `call-tool "${toolName}" on client "${displayName}" failed: ${(err as Error).message}`
    );
  }
};

const connectClient = async (
  id: string,
  state: ChatState
): Promise<HandlerResult> => {
  const { context } = state;
  const mcpClient = findClient(state, id);
  if (!mcpClient) return fail(`No client found with id: ${id}`);

  const active = pickActiveTransport(mcpClient);
  if (!active) return fail(`No transport configured for client: ${id}`);

  const existing = (mcpClient.client as unknown as { transport?: { close: () => Promise<void> } }).transport;
  if (existing) {
    try { await existing.close(); } catch (err) {
      context?.log(`MCP: error closing previous transport for ${id}: ${(err as Error).message}`, {}, "warn");
    }
  }

  // During connect() the SDK fires the same error through both the onerror
  // listener AND the connect-promise rejection. Gate listener output so only
  // post-connect runtime failures surface in logs.
  let connectInFlight = true;

  mcpClient.client.onclose = () => {
    if (connectInFlight) return;
    context?.log(`MCP: client ${id} transport closed`, {}, "info");
  };
  mcpClient.client.onerror = (error: Error) => {
    if (connectInFlight) return;
    context?.log(`MCP: client ${id} error: ${error.message}`, { error }, "error");
  };

  const errCtx = {
    kind: active.kind,
    url: mcpClient.url,
    command: mcpClient.command,
    id: mcpClient.id,
  } as const;

  try {
    await mcpClient.client.connect(active.transport);
  } catch (err) {
    // OAuth: the SDK throws UnauthorizedError after invoking the provider's
    // redirectToAuthorization. Surface the consent URL rather than a hard error
    // so the user can authorize and re-run connect.
    if (err instanceof UnauthorizedError || mcpClient.authProvider?.pendingAuthorizationUrl) {
      const authorizationUrl = mcpClient.authProvider?.pendingAuthorizationUrl;
      context?.log(`MCP: client ${id} requires authorization`, { authorizationUrl }, "info");
      if (state.sessionFolder) {
        updateConnectionStatus(state.sessionFolder, mcpClient.id, "inactive");
      }
      return {
        success: false,
        error: authorizationUrl
          ? `MCP server "${mcpClient.name ?? id}" requires OAuth authorization.`
          : `MCP server "${mcpClient.name ?? id}" requires OAuth authorization, but no authorization URL was produced.`,
        data: { needsAuthorization: true, id: mcpClient.id, authorizationUrl },
      };
    }
    const classified = classifyMcpError(err, errCtx);
    const rawMessage = err instanceof Error ? err.message : String(err);
    context?.log(
      `MCP: connect failed for ${id} via ${active.kind}: ${classified}`,
      { raw: rawMessage },
      "error"
    );
    if (state.sessionFolder) {
      updateConnectionStatus(state.sessionFolder, mcpClient.id, "error");
    }
    return fail(classified);
  } finally {
    connectInFlight = false;
  }

  if (state.sessionFolder) {
    updateConnectionStatus(state.sessionFolder, mcpClient.id, "active");
  }

  const capabilities = mcpClient.client.getServerCapabilities();
  const [toolsList, promptsList, resourcesList] = await Promise.all([
    capabilities?.tools ? mcpClient.client.listTools().catch(() => ({ tools: [] })) : Promise.resolve({ tools: [] }),
    capabilities?.prompts ? mcpClient.client.listPrompts().catch(() => ({ prompts: [] })) : Promise.resolve({ prompts: [] }),
    capabilities?.resources ? mcpClient.client.listResources().catch(() => ({ resources: [] })) : Promise.resolve({ resources: [] }),
  ]);

  const summary = {
    id: mcpClient.id,
    name: mcpClient.name,
    transport: active.kind,
    serverInfo: mcpClient.client.getServerVersion?.() ?? null,
    capabilities,
    toolCount: (toolsList as { tools?: unknown[] }).tools?.length ?? 0,
    promptCount: (promptsList as { prompts?: unknown[] }).prompts?.length ?? 0,
    resourceCount: (resourcesList as { resources?: unknown[] }).resources?.length ?? 0,
  };
  return ok(summary);
};

const disconnectClient = async (
  id: string,
  state: ChatState
): Promise<HandlerResult> => {
  const client = findClient(state, id);
  if (!client) return fail(`No client found with id: ${id}`);

  const transport = (client.client as unknown as { transport?: { close: () => Promise<void> } }).transport;
  if (transport) {
    try { await transport.close(); } catch (err) {
      return fail(`Failed to close transport: ${(err as Error).message}`);
    }
  }

  if (state.sessionFolder) {
    updateConnectionStatus(state.sessionFolder, client.id, "inactive");
  }

  return ok({ id: client.id, message: `Disconnected from ${client.id}` });
};

/**
 * Clears the stored OAuth grant for a connection (revokes local credentials).
 * The next connect will trigger a fresh authorization.
 */
const logoutClient = async (
  id: string,
  state: ChatState
): Promise<HandlerResult> => {
  const client = findClient(state, id);
  if (!client) return fail(`No client found with id: ${id}`);

  const user = state.context?.user as unknown as TokenStoreUser | undefined;
  if (!user || typeof user.removeAuthentication !== "function") {
    return fail("No user on the session context — cannot clear stored OAuth credentials.");
  }

  const store = new UserAuthenticationsTokenStore(user);
  await store.remove(`mcp:${client.name ?? id}`);

  if (state.sessionFolder) {
    updateConnectionStatus(state.sessionFolder, client.id, "inactive");
  }
  return ok({ id: client.id, message: `Cleared OAuth credentials for ${client.name ?? id}.` });
};

const listConnections = async (state: ChatState): Promise<HandlerResult> => {
  const connections = (state.mcpClients ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    transport: c.transports?.http ? "http" : c.transports?.stdio ? "stdio" : "unknown",
  }));
  return ok(connections);
};

const getAvailable = async (
  format: "json" | "text",
  state: ChatState
): Promise<HandlerResult> => {
  // The registry merges two sources: the curated operator catalog (available.yaml)
  // and the user's standard config (~/.reactor/mcp.yaml). Either alone is enough.
  const services = loadAvailableCatalog();
  const stdioAllowed = isStdioAllowed();
  const connectedNames = new Set((state.mcpClients ?? []).map((c) => c.name));

  const enriched = services.map((svc) => ({
    ...svc,
    connected: connectedNames.has(svc.id),
    available: svc.transport === "stdio" ? stdioAllowed : true,
  }));

  if (format === "json") return ok(enriched);

  if (enriched.length === 0) {
    const curated = availableCatalogPath();
    const standardPaths = standardMcpConfigPaths();
    return ok(
      `No MCP services are defined. Looked in:\n` +
        `- ${curated ?? "(REACTORY_DATA not set — no available.yaml path)"}\n` +
        (standardPaths.length
          ? standardPaths.map((p) => `- ${p}`).join("\n")
          : `- ${standardMcpConfigPath()} (not found)`)
    );
  }

  const lines = enriched.map((svc) => {
    const status = svc.connected ? " (connected)" : "";
    const gated = svc.transport === "stdio" && !stdioAllowed ? " (stdio disabled in this runtime)" : "";
    const locator = svc.transport === "stdio"
      ? `command: ${svc.command ?? "(missing)"}`
      : `url: ${svc.url ?? "(missing)"}`;
    return `- **${svc.name}** [${svc.id}]${status}${gated}\n  ${svc.description}\n  Transport: ${svc.transport} | ${locator}`;
  });
  return ok(
    `Available MCP services:\n\n${lines.join("\n\n")}\n\nUse add-connection to register a service.`
  );
};

// ── Instruction templates ───────────────────────────────────────────────────
const AVAILABLE_COMMANDS =
  "capabilities, prompts, tools, resources, add-connection, connect, disconnect, connections, call-tool, available, authorize, logout";

const instructionsFor = (command: string, result: HandlerResult, extra?: Record<string, string>): string => {
  if (!result.success) {
    // OAuth: connect surfaced an authorization URL — guide the user to authorize.
    const data = result.data as { needsAuthorization?: boolean; authorizationUrl?: string; id?: string } | undefined;
    if (data?.needsAuthorization) {
      const urlLine = data.authorizationUrl
        ? `1. Open this URL in a browser to authorize:\n\n   ${data.authorizationUrl}\n`
        : `1. No authorization URL was produced — check the server's OAuth configuration.\n`;
      return (
        `## MCP ${command} — Authorization required\n\n${result.error}\n\n### Next Steps:\n` +
        urlLine +
        `2. After granting consent, run \`mcp\` command="connect" id="${data.id ?? extra?.id ?? "<id>"}" again.\n` +
        `- In local (desktop) mode the browser opens automatically.\n` +
        `- Use command="logout" id=... to clear a stored grant and re-authorize.`
      );
    }
    return `## MCP ${command} — Error\n\n${result.error}\n\n### Recovery Options:\n- Use \`mcp\` with command="connections" to check registered clients\n- Use \`mcp\` with command="available" to see catalog services\n- Use \`mcp\` with command="connect" to reestablish a connection`;
  }
  switch (command) {
    case "capabilities":
      return `## MCP Server Capabilities\n\nRetrieved capabilities.\n\n### Next Steps:\n- Use command="tools" to list tools\n- Use command="prompts" to list prompts\n- Use command="resources" to list resources`;
    case "prompts":
      return `## MCP Prompts\n\nRetrieved prompts.\n\n### Next Steps:\n- Use command="tools" or command="call-tool"`;
    case "tools":
      return `## MCP Tools\n\nRetrieved tool list for ${extra?.id ?? "default"} client.\n\n### Next Steps:\n- Use command="call-tool", id, toolName, toolArgs={...}\n- Use format="json" for machine-readable output`;
    case "resources":
      return `## MCP Resources\n\nRetrieved resources.`;
    case "add-connection":
      return `## MCP Connection Added\n\n### Next Steps:\n- Use command="connect", id="<connection_id>" to establish the transport\n- Use command="connections" to list all registered clients`;
    case "connect":
      return `## MCP Client Connected\n\n### Next Steps:\n- Use command="tools", id="${extra?.id}" to discover available tools\n- Use command="call-tool" to execute a tool`;
    case "disconnect":
      return `## MCP Client Disconnected\n\n### Next Steps:\n- Use command="connect", id="${extra?.id}" to reconnect`;
    case "authorize":
      return `## MCP Authorization\n\n### Next Steps:\n- Complete consent in the browser if prompted, then command="connect" id="${extra?.id}"`;
    case "logout":
      return `## MCP OAuth Credentials Cleared\n\n### Next Steps:\n- Use command="connect", id="${extra?.id}" to authorize again`;
    case "call-tool":
      return `## MCP Tool Executed\n\nTool **${extra?.toolName}** on client **${extra?.id}** returned.\n\n### Next Steps:\n- Inspect the returned data\n- Use \`var\` to store it for later`;
    case "available":
      return `## Available MCP Services\n\n### Next Steps:\n- Use command="add-connection", id, url to register an http service\n- Use command="add-connection", id, transport="stdio" to register a stdio service (desktop or gated server only)\n- Use command="connect", id to establish the transport`;
    case "connections":
    default:
      return `## MCP Connections\n\n### Available Commands:\n${AVAILABLE_COMMANDS}\n\n### Next Steps:\n- Use command="add-connection" to register a new server\n- Use command="connect" to establish a transport\n- Use command="tools" to discover tools`;
  }
};

// ── Entry point ─────────────────────────────────────────────────────────────

export const McpCli: Macro<unknown, McpCliProps> = async (
  props: McpCliProps,
  state: ChatState
): Promise<unknown> => {
  try {
    loadClientsFromSession(state);

    const {
      command = "connections",
      id,
      url,
      transport = "http",
      toolName,
      toolArgs,
      toolParams,
      format = "text",
    } = props as McpCliProps & { toolArgs?: Record<string, unknown> };

    let result: HandlerResult;
    const extra: Record<string, string> = {};

    switch (command) {
      case "capabilities":
        result = await getCapabilities(id, state);
        break;
      case "prompts":
        result = await getPrompts(id, state);
        break;
      case "tools":
        result = await getTools(id, format, state);
        extra.id = id ?? "default";
        break;
      case "resources":
        result = await getResources(id, state);
        break;
      case "add-connection":
        if (!id) {
          result = fail("add-connection requires id.");
        } else {
          result = await addConnection(id, url, transport as McpTransportKind, state);
        }
        break;
      case "connect":
        if (!id) {
          result = fail("connect requires id.");
        } else {
          result = await connectClient(id, state);
          extra.id = id;
        }
        break;
      case "disconnect":
        if (!id) {
          result = fail("disconnect requires id.");
        } else {
          result = await disconnectClient(id, state);
          extra.id = id;
        }
        break;
      case "authorize":
        // Authorization is driven by the connect handshake; re-running connect
        // (re)issues the consent URL when the server requires OAuth.
        if (!id) {
          result = fail("authorize requires id.");
        } else {
          result = await connectClient(id, state);
          extra.id = id;
        }
        break;
      case "logout":
        if (!id) {
          result = fail("logout requires id.");
        } else {
          result = await logoutClient(id, state);
          extra.id = id;
        }
        break;
      case "call-tool":
        if (!id || !toolName) {
          result = fail("call-tool requires id and toolName.");
        } else {
          result = await callTool(id, toolName, toolArgs, toolParams, state);
          extra.id = id;
          extra.toolName = toolName;
        }
        break;
      case "available":
        result = await getAvailable(format, state);
        break;
      case "connections":
      default:
        result = await listConnections(state);
        break;
    }

    return {
      ...result,
      instructions: instructionsFor(command, result, extra),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const command = (props as McpCliProps)?.command ?? "(unknown)";
    state.context?.log(`MCP macro error in command "${command}": ${message}`, { error }, "error");
    return {
      success: false,
      error: `MCP ${command} failed: ${message}`,
      instructions: `## MCP ${command} — Error\n\n${message}\n\n### Recovery Options:\n- Use command="connections" to inspect client state\n- Use command="available" to see catalog entries\n- Verify the MCP server is running and reachable\n- Available commands: ${AVAILABLE_COMMANDS}`,
    };
  }
};

export const McpClientMacroRegistry: MacroComponentDefinition<typeof McpCli> = {
  nameSpace: "reactor-macros",
  name: "mcp",
  version: "1.0.0",
  component: McpCli,
  description: `# MCP Client Macro

  Interact with Model Context Protocol (MCP) servers registered in this session.

  ## Typical flow
  1. command="available" — list catalog services
  2. command="add-connection", id, url — register an http connection
     OR command="add-connection", id, transport="stdio" — register a stdio service from the catalog
  3. command="connect", id=<returned_uuid> — open the transport
  4. command="tools", id=<uuid> — list available tools
  5. command="call-tool", id, toolName, toolArgs={...} — invoke a tool
  6. command="disconnect", id — optional, closes the transport

  ## Transports
  - http  — Streamable HTTP (MCP spec). Default for remote services.
  - stdio — local child process. Desktop/electron and gated server deployments
            only (REACTORY_MCP_STDIO_ENABLED=true). Command/args/env are
            resolved from the catalog entry; the agent never supplies them.

  ## Catalog sources
  The registry ("available" command) merges two sources:
  - the curated operator catalog at $REACTORY_DATA/profiles/reactor/mcp/available.yaml
  - the user's standard config at ~/.reactor/mcp.{json,yaml,yml} (the same
    "mcpServers" map format used by Claude Desktop / Cursor). Either source alone
    is sufficient. On an id collision the curated catalog wins.

  ## Security
  Auth credentials are only forwarded to URLs present in available.yaml or
  the standard ~/.reactor config. stdio services (from either source) remain gated by
  REACTORY_MCP_STDIO_ENABLED outside the desktop shell.
  `,
  features: [
    {
      feature: "capabilities",
      featureType: Reactory.FeatureType.function,
      action: ["get", "fetch", "retrieve"],
    },
    {
      feature: "available",
      featureType: Reactory.FeatureType.function,
      action: ["list", "get"],
    },
  ],
  stem: "mcp",
  tags: ["mcp", "chat", "session", "context"],
  roles: ["USER"],
  tools: [
    {
      type: "function",
      function: {
        name: "mcp",
        description:
          "Interact with registered MCP (Model Context Protocol) servers. Use command='available' to browse the catalog, then add-connection → connect → tools → call-tool. Transports: http (Streamable HTTP) for remote services, stdio for local catalog-defined services (desktop or gated server only).",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: [
                "capabilities",
                "prompts",
                "tools",
                "resources",
                "add-connection",
                "connect",
                "disconnect",
                "connections",
                "call-tool",
                "available",
                "authorize",
                "logout",
              ],
              description: "The MCP command to execute",
            },
            id: {
              type: "string",
              description:
                "For connect/disconnect/call-tool: the connection uuid returned by add-connection. For add-connection: the catalog service id (required) — also used as the name.",
            },
            url: {
              type: "string",
              description: "URL of the MCP server. Required for add-connection when transport='http'.",
            },
            transport: {
              type: "string",
              enum: ["http", "stdio"],
              description:
                "Transport kind. 'http' = Streamable HTTP per MCP spec (default, for remote services). 'stdio' = local child-process transport — requires a matching entry in available.yaml and is disabled on server deployments unless REACTORY_MCP_STDIO_ENABLED=true.",
            },
            toolName: {
              type: "string",
              description: "Tool name for call-tool.",
            },
            toolArgs: {
              type: "object",
              description:
                "Structured arguments object for call-tool. Preferred over toolParams. Shape must match the remote tool's schema.",
              additionalProperties: true,
            },
            toolParams: {
              type: "array",
              items: { type: "string" },
              description:
                "Deprecated. Positional string arguments wrapped as {args: [...]} when toolArgs is absent. Prefer toolArgs.",
            },
            format: {
              type: "string",
              enum: ["json", "text"],
              description: "Response format for tools/available.",
            },
          },
          required: ["command"],
        },
      },
    },
  ],
};
