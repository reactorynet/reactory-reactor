import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";
import { McpTransportKind } from "./session-config";

/**
 * OAuth / auth descriptor for an MCP service. `type` defaults to undefined,
 * which preserves the legacy static-header behaviour. `oauth` opts the service
 * into the SDK-driven OAuth 2.0 flow (see ./oauth/ReactoryMcpOAuthProvider).
 */
export interface McpAuthConfig {
  type: "none" | "bearer" | "oauth";
  scopes?: string[];
  /** Overrides when the server does not support discovery / dynamic registration. */
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  /** Pre-registered client (skips Dynamic Client Registration). `${ENV}` interpolated. */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Catalog entry describing a single MCP service the agent may connect to.
 *
 * Two sources feed the catalog:
 *  - the curated operator catalog at `$REACTORY_DATA/profiles/reactor/mcp/available.yaml`
 *    (`source: "available.yaml"`), and
 *  - the user's standard MCP config at `~/.reactor/mcp.yaml`
 *    (`source: "standard-config"`), which uses the same `mcpServers` map format
 *    understood by Claude Desktop, Cursor and the wider MCP ecosystem.
 */
export interface AvailableServiceEntry {
  id: string;
  name: string;
  description: string;
  transport: McpTransportKind;
  /** Required for http transport */
  url?: string;
  /** Optional static headers merged into the http transport (never overrides auth headers). */
  headers?: Record<string, string>;
  /** Required for stdio transport; catalog-supplied, never agent-supplied */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  connectorRef?: string;
  tags?: string[];
  requiredEnvVars?: string[];
  autoConnect?: boolean;
  /** Optional OAuth / auth descriptor. Absent = legacy static-header behaviour. */
  auth?: McpAuthConfig;
  /** Where this entry originated. */
  source?: "available.yaml" | "standard-config";
}

/**
 * Expands `${VAR}` and `${VAR:default}` references from `process.env`.
 * Shared by the curated catalog loader and the standard-config loader.
 */
export const resolveEnvTemplate = (value: string): string =>
  value.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_match, envKey, fallback) =>
    process.env[envKey] || fallback || ""
  );

const resolveEnvMap = (
  map?: Record<string, string>
): Record<string, string> | undefined => {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = typeof v === "string" ? resolveEnvTemplate(v) : v;
  }
  return out;
};

/** Raw shape of a single server entry in a standard `mcpServers` map. */
interface RawStandardServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Some ecosystems declare the transport as `type` or `transport`. */
  type?: string;
  transport?: string;
  description?: string;
  /** When true the entry is skipped (parity with editors that support toggling). */
  disabled?: boolean;
  requiredEnvVars?: string[];
  auth?: McpAuthConfig;
}

/** Interpolate `${ENV}` in the sensitive/URL fields of an auth descriptor. */
const resolveAuthConfig = (auth?: McpAuthConfig): McpAuthConfig | undefined => {
  if (!auth) return undefined;
  return {
    ...auth,
    authorizationUrl: auth.authorizationUrl ? resolveEnvTemplate(auth.authorizationUrl) : undefined,
    tokenUrl: auth.tokenUrl ? resolveEnvTemplate(auth.tokenUrl) : undefined,
    issuer: auth.issuer ? resolveEnvTemplate(auth.issuer) : undefined,
    clientId: auth.clientId ? resolveEnvTemplate(auth.clientId) : undefined,
    clientSecret: auth.clientSecret ? resolveEnvTemplate(auth.clientSecret) : undefined,
  };
};

/** Recognised filenames for the standard config, in precedence order. */
export const STANDARD_CONFIG_FILENAMES = ["mcp.json", "mcp.yaml", "mcp.yml"];

const reactorDir = (): string => path.join(process.env.HOME || os.homedir(), ".reactor");

/**
 * Every standard MCP config file that exists. When `REACTOR_MCP_CONFIG` is set it
 * is used verbatim (single file — primarily so tests stay hermetic). Otherwise
 * ALL recognised files in `~/.reactor` are returned, so servers spread across
 * `mcp.json` and `mcp.yaml` are all loaded. Order follows STANDARD_CONFIG_FILENAMES,
 * which also defines precedence on id collisions (earlier file wins).
 */
export const standardMcpConfigPaths = (): string[] => {
  if (process.env.REACTOR_MCP_CONFIG) return [process.env.REACTOR_MCP_CONFIG];
  const dir = reactorDir();
  return STANDARD_CONFIG_FILENAMES.map((name) => path.join(dir, name)).filter((p) => fs.existsSync(p));
};

/**
 * The first existing standard config file, or the default `mcp.yaml` path when
 * none exist. Retained for diagnostics / messaging; use {@link standardMcpConfigPaths}
 * to actually load servers.
 */
export const standardMcpConfigPath = (): string => {
  const paths = standardMcpConfigPaths();
  return paths.length ? paths[0] : path.join(reactorDir(), "mcp.yaml");
};

const toEntry = (name: string, cfg: RawStandardServer, sourcePath?: string): AvailableServiceEntry | null => {
  if (!cfg || typeof cfg !== "object" || cfg.disabled === true) return null;
  const sourceLabel = sourcePath ? `~/.reactor/${path.basename(sourcePath)}` : "~/.reactor";

  const declared = (cfg.type || cfg.transport || "").toLowerCase();
  let transport: McpTransportKind;
  if (declared === "stdio") transport = "stdio";
  else if (declared === "sse" || declared === "http") transport = "http"; // normalise sse → http
  else if (cfg.command) transport = "stdio";
  else if (cfg.url) transport = "http";
  else return null; // nothing usable

  const base: AvailableServiceEntry = {
    id: name,
    name,
    description: cfg.description || `Standard MCP server "${name}" (${sourceLabel})`,
    transport,
    requiredEnvVars: cfg.requiredEnvVars,
    auth: resolveAuthConfig(cfg.auth),
    source: "standard-config",
  };

  if (transport === "stdio") {
    if (!cfg.command) return null;
    return {
      ...base,
      command: cfg.command,
      args: cfg.args ?? [],
      env: resolveEnvMap(cfg.env),
      cwd: cfg.cwd,
    };
  }

  if (!cfg.url) return null;
  return {
    ...base,
    url: resolveEnvTemplate(cfg.url),
    headers: resolveEnvMap(cfg.headers),
  };
};

/** Parse a single standard config file. Never throws. */
const loadFromFile = (p: string): AvailableServiceEntry[] => {
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = yaml.load(raw) as { mcpServers?: Record<string, RawStandardServer> } | undefined;
    const servers = parsed?.mcpServers ?? {};
    return Object.entries(servers)
      .map(([name, cfg]) => toEntry(name, cfg, p))
      .filter((e): e is AvailableServiceEntry => e !== null);
  } catch {
    return [];
  }
};

/**
 * Reads every standard `mcpServers`-format config file in `~/.reactor`
 * (`mcp.json`, `mcp.yaml`, `mcp.yml` — JSON is parsed by the same YAML loader)
 * and converts each declared server into an {@link AvailableServiceEntry}.
 * Servers from all files are merged; on an id collision the earlier file (per
 * STANDARD_CONFIG_FILENAMES order) wins. Never throws.
 */
export const loadStandardMcpServers = (): AvailableServiceEntry[] => {
  const byId = new Map<string, AvailableServiceEntry>();
  for (const p of standardMcpConfigPaths()) {
    for (const entry of loadFromFile(p)) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values());
};
