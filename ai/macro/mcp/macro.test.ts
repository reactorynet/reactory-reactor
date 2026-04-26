/**
 * Unit tests for the MCP client macro.
 *
 * Exercises the macro ↔ session-config ↔ load-clients ↔ catalog round-trip
 * against a tempdir `REACTORY_DATA`, with the MCP SDK transports and Client
 * mocked at the module boundary. Plan: ./macro_plan.md
 */
import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";
import { v4 as uuidv4 } from "uuid";
// ── SDK mocks ──────────────────────────────────────────────────────────────

// Default mock Client: records the transport it was connected with and returns
// a predictable capability set. Tests can override individual method behaviour
// via `mockClientImpl`.
let mockClientImpl: ((config: unknown) => Record<string, unknown>) | null = null;

jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(function (this: Record<string, unknown>, config: unknown) {
    const override = mockClientImpl ? mockClientImpl(config) : {};
    this.config = config;
    this.transport = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this.connect = jest.fn().mockImplementation(async (transport: unknown) => {
      (this as { transport: unknown }).transport = transport;
    });
    this.getServerCapabilities = jest.fn().mockReturnValue({ tools: true, prompts: false, resources: false });
    this.getServerVersion = jest.fn().mockReturnValue({ name: "mock-server", version: "1.0.0" });
    this.listTools = jest.fn().mockResolvedValue({ tools: [{ name: "search", description: "search tool" }] });
    this.listPrompts = jest.fn().mockResolvedValue({ prompts: [] });
    this.listResources = jest.fn().mockResolvedValue({ resources: [] });
    this.callTool = jest.fn().mockImplementation(async (params: { name: string; arguments?: unknown }) => ({
      content: [{ type: "text", text: `called ${params.name}` }],
      echoedArgs: params.arguments,
    }));
    Object.assign(this, override);
  }),
}));

jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(function (this: Record<string, unknown>, url: URL, opts?: unknown) {
    this.kind = "http";
    this.url = url;
    this.opts = opts;
    this.close = jest.fn().mockResolvedValue(undefined);
  }),
}));

jest.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: jest.fn().mockImplementation(function (this: Record<string, unknown>, server: unknown) {
    this.kind = "stdio";
    this.server = server;
    this.close = jest.fn().mockResolvedValue(undefined);
  }),
}));

// ── Test harness ───────────────────────────────────────────────────────────

import { McpCli } from "./macro";
import type { McpCliProps } from "./types";
import type { ChatState } from "../../openai/types/chat";
import type { McpConnectionEntry } from "./session-config";

interface McpCliResult {
  success: boolean;
  data?: unknown;
  error?: string;
  instructions?: string;
}

const makeState = (overrides: Partial<ChatState> = {}): ChatState => {
  const ctx = {
    log: jest.fn(),
    user: { id: "test-user" },
  };
  return {
    personaId: "mcp-test",
    modelId: "gpt-4",
    started: new Date(),
    history: [],
    ai: {} as never,
    macros: [],
    tools: [],
    apiKey: "test",
    apiOrg: "test",
    authToken: "TEST_TOKEN",
    vars: {},
    context: ctx as unknown as ChatState["context"],
    ...overrides,
  } as ChatState;
};

const writeCatalog = (dataRoot: string, services: Array<Record<string, unknown>>) => {
  const dir = path.join(dataRoot, "profiles", "reactor", "mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "available.yaml"), yaml.dump({ version: "1.0", services }), "utf8");
};

const readMcpYaml = (sessionFolder: string): { connections: McpConnectionEntry[] } => {
  const p = path.join(sessionFolder, "mcp.yaml");
  if (!fs.existsSync(p)) return { connections: [] };
  return yaml.load(fs.readFileSync(p, "utf8")) as { connections: McpConnectionEntry[] };
};

const writeMcpYaml = (sessionFolder: string, connections: Array<Record<string, unknown>>) => {
  fs.mkdirSync(sessionFolder, { recursive: true });
  fs.writeFileSync(path.join(sessionFolder, "mcp.yaml"), yaml.dump({ version: "1.0", connections }), "utf8");
};

const run = (props: McpCliProps, state: ChatState) =>
  McpCli(props, state) as Promise<McpCliResult>;

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpRoot: string;
let dataRoot: string;
let sessionFolder: string;

const ORIG_DATA = process.env.REACTORY_DATA;
const ORIG_APP_DATA = process.env.APP_DATA_ROOT;
const ORIG_STDIO = process.env.REACTORY_MCP_STDIO_ENABLED;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-macro-${uuidv4()}-`));
  dataRoot = path.join(tmpRoot, "data");
  sessionFolder = path.join(tmpRoot, "session");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(sessionFolder, { recursive: true });
  process.env.REACTORY_DATA = dataRoot;
  delete process.env.APP_DATA_ROOT; // prevent .env.local fallback from defeating REACTORY_DATA deletion
  delete process.env.REACTORY_MCP_STDIO_ENABLED;
  mockClientImpl = null;
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIG_DATA === undefined) delete process.env.REACTORY_DATA;
  else process.env.REACTORY_DATA = ORIG_DATA;
  if (ORIG_APP_DATA === undefined) delete process.env.APP_DATA_ROOT;
  else process.env.APP_DATA_ROOT = ORIG_APP_DATA;
  if (ORIG_STDIO === undefined) delete process.env.REACTORY_MCP_STDIO_ENABLED;
  else process.env.REACTORY_MCP_STDIO_ENABLED = ORIG_STDIO;
});

// ─────────────────────────────────────────────────────────────────────────────
//   available
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — available", () => {
  it("fails when REACTORY_DATA is unset", async () => {
    delete process.env.REACTORY_DATA;
    const result = await run({ command: "available" }, makeState({ sessionFolder }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/REACTORY_DATA/);
  });

  it("fails when available.yaml is missing", async () => {
    const result = await run({ command: "available" }, makeState({ sessionFolder }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/available\.yaml/);
  });

  it("returns http + stdio services from the catalog", async () => {
    writeCatalog(dataRoot, [
      { id: "remote", name: "Remote", description: "desc", transport: "http", url: "https://remote.example/mcp" },
      { id: "fs", name: "Filesystem", description: "local fs", transport: "stdio", command: "npx", args: ["-y", "server-filesystem"] },
    ]);

    const result = await run({ command: "available", format: "json" }, makeState({ sessionFolder }));
    expect(result.success).toBe(true);
    const data = result.data as Array<{ id: string; transport: string; available: boolean }>;
    expect(data).toHaveLength(2);
    const remote = data.find((d) => d.id === "remote")!;
    const fsEntry = data.find((d) => d.id === "fs")!;
    expect(remote.available).toBe(true);
    expect(fsEntry.available).toBe(false); // stdio gated off by default
  });

  it("marks stdio services available when REACTORY_MCP_STDIO_ENABLED=true", async () => {
    process.env.REACTORY_MCP_STDIO_ENABLED = "true";
    writeCatalog(dataRoot, [
      { id: "fs", name: "Filesystem", description: "local", transport: "stdio", command: "npx" },
    ]);
    const result = await run({ command: "available", format: "json" }, makeState({ sessionFolder }));
    const data = result.data as Array<{ available: boolean }>;
    expect(data[0].available).toBe(true);
  });

  it("normalises legacy 'sse' catalog entries to 'http'", async () => {
    writeCatalog(dataRoot, [
      { id: "legacy", name: "Legacy", description: "old sse entry", transport: "sse", url: "https://old.example/mcp" },
    ]);
    const result = await run({ command: "available", format: "json" }, makeState({ sessionFolder }));
    const data = result.data as Array<{ transport: string }>;
    expect(data[0].transport).toBe("http");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   add-connection (http)
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — add-connection (http)", () => {
  it("requires url for http transport", async () => {
    writeCatalog(dataRoot, []);
    const result = await run(
      { command: "add-connection", id: "remote", transport: "http" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/url/);
  });

  it("registers connection, generates uuid, persists to mcp.yaml", async () => {
    writeCatalog(dataRoot, [
      { id: "remote", name: "Remote", description: "", transport: "http", url: "https://remote.example/mcp" },
    ]);
    const state = makeState({ sessionFolder });

    const result = await run(
      { command: "add-connection", id: "remote", url: "https://remote.example/mcp", transport: "http" },
      state
    );
    expect(result.success).toBe(true);

    const persisted = readMcpYaml(sessionFolder);
    expect(persisted.connections).toHaveLength(1);
    expect(persisted.connections[0].serverName).toBe("remote");
    expect(persisted.connections[0].transport).toBe("http");
    expect(persisted.connections[0].status).toBe("inactive");
    expect(state.mcpClients).toHaveLength(1);
  });

  it("dedupes when same id is registered twice in the same session", async () => {
    writeCatalog(dataRoot, []);
    const state = makeState({ sessionFolder });

    const first = await run(
      { command: "add-connection", id: "remote", url: "https://host.example/mcp", transport: "http" },
      state
    );
    const second = await run(
      { command: "add-connection", id: "remote", url: "https://host.example/mcp", transport: "http" },
      state
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect((second.data as { reused?: boolean }).reused).toBe(true);
    expect(state.mcpClients).toHaveLength(1);
  });

  it("forwards credentials only when URL matches a catalog entry", async () => {
    writeCatalog(dataRoot, [
      { id: "remote", name: "Remote", description: "", transport: "http", url: "https://remote.example/mcp" },
    ]);

    const stateInCatalog = makeState({ sessionFolder });
    const inCatalogResult = await run(
      { command: "add-connection", id: "remote", url: "https://remote.example/mcp", transport: "http" },
      stateInCatalog
    );
    expect((inCatalogResult.data as { credentialsForwarded: boolean }).credentialsForwarded).toBe(true);

    const sessionFolder2 = path.join(tmpRoot, "session2");
    fs.mkdirSync(sessionFolder2, { recursive: true });
    const stateOutOfCatalog = makeState({ sessionFolder: sessionFolder2 });
    const outResult = await run(
      { command: "add-connection", id: "rogue", url: "https://attacker.example/mcp", transport: "http" },
      stateOutOfCatalog
    );
    expect((outResult.data as { credentialsForwarded: boolean }).credentialsForwarded).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   add-connection (stdio)
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — add-connection (stdio)", () => {
  it("fails with gating message when stdio is disabled", async () => {
    writeCatalog(dataRoot, [
      { id: "fs", name: "Filesystem", description: "", transport: "stdio", command: "npx" },
    ]);
    const result = await run(
      { command: "add-connection", id: "fs", transport: "stdio" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/stdio transport is disabled/);
  });

  it("fails when no catalog entry matches the id", async () => {
    process.env.REACTORY_MCP_STDIO_ENABLED = "true";
    writeCatalog(dataRoot, []);
    const result = await run(
      { command: "add-connection", id: "nonexistent", transport: "stdio" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/available\.yaml/);
  });

  it("fails when catalog entry transport is not stdio", async () => {
    process.env.REACTORY_MCP_STDIO_ENABLED = "true";
    writeCatalog(dataRoot, [
      { id: "remote", name: "Remote", description: "", transport: "http", url: "https://remote.example/mcp" },
    ]);
    const result = await run(
      { command: "add-connection", id: "remote", transport: "stdio" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not stdio/);
  });

  it("fails when catalog stdio entry is missing command", async () => {
    process.env.REACTORY_MCP_STDIO_ENABLED = "true";
    writeCatalog(dataRoot, [
      { id: "fs", name: "Filesystem", description: "", transport: "stdio" },
    ]);
    const result = await run(
      { command: "add-connection", id: "fs", transport: "stdio" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/command/);
  });

  it("succeeds when gated env var is set and catalog entry is valid", async () => {
    process.env.REACTORY_MCP_STDIO_ENABLED = "true";
    writeCatalog(dataRoot, [
      { id: "fs", name: "Filesystem", description: "local fs", transport: "stdio", command: "npx", args: ["-y", "server-filesystem", "/tmp"] },
    ]);
    const state = makeState({ sessionFolder });
    const result = await run(
      { command: "add-connection", id: "fs", transport: "stdio" },
      state
    );
    expect(result.success).toBe(true);

    const persisted = readMcpYaml(sessionFolder);
    expect(persisted.connections).toHaveLength(1);
    expect(persisted.connections[0].transport).toBe("stdio");
    expect(persisted.connections[0].command).toBe("npx");
    expect(persisted.connections[0].args).toEqual(["-y", "server-filesystem", "/tmp"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   connections
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — connections", () => {
  it("returns an empty list when no connections", async () => {
    writeCatalog(dataRoot, []);
    const result = await run({ command: "connections" }, makeState({ sessionFolder }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("lists connection with transport tag after add-connection", async () => {
    writeCatalog(dataRoot, []);
    const state = makeState({ sessionFolder });
    await run(
      { command: "add-connection", id: "remote", url: "https://remote.example/mcp", transport: "http" },
      state
    );
    const result = await run({ command: "connections" }, state);
    const data = result.data as Array<{ name: string; transport: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("remote");
    expect(data[0].transport).toBe("http");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   connect
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — connect", () => {
  it("fails when the client id is not found", async () => {
    const result = await run({ command: "connect", id: "missing" }, makeState({ sessionFolder }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No client found/);
  });

  it("connects the transport and returns a capability summary", async () => {
    writeCatalog(dataRoot, [
      { id: "remote", name: "Remote", description: "", transport: "http", url: "https://remote.example/mcp" },
    ]);
    const state = makeState({ sessionFolder });
    const added = await run(
      { command: "add-connection", id: "remote", url: "https://remote.example/mcp", transport: "http" },
      state
    );
    const connectionId = (added.data as { id: string }).id;

    const result = await run({ command: "connect", id: connectionId }, state);
    expect(result.success).toBe(true);
    const data = result.data as { transport: string; toolCount: number; capabilities: unknown };
    expect(data.transport).toBe("http");
    expect(data.toolCount).toBe(1);
    expect(data.capabilities).toBeDefined();

    const persisted = readMcpYaml(sessionFolder);
    expect(persisted.connections[0].status).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   call-tool
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — call-tool", () => {
  const setupConnected = async () => {
    writeCatalog(dataRoot, []);
    const state = makeState({ sessionFolder });
    const added = await run(
      { command: "add-connection", id: "remote", url: "https://remote.example/mcp", transport: "http" },
      state
    );
    const id = (added.data as { id: string }).id;
    await run({ command: "connect", id }, state);
    return { state, id };
  };

  it("fails when client id not found", async () => {
    const result = await run(
      { command: "call-tool", id: "missing", toolName: "search" },
      makeState({ sessionFolder })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No client found/);
  });

  it("fails when tool name is not registered on the server", async () => {
    const { state, id } = await setupConnected();
    const result = await run({ command: "call-tool", id, toolName: "unknown" }, state);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No tool named "unknown"/);
  });

  it("passes structured toolArgs to the SDK", async () => {
    const { state, id } = await setupConnected();
    const result = await run(
      { command: "call-tool", id, toolName: "search", toolArgs: { query: "hello" } },
      state
    );
    expect(result.success).toBe(true);
    const mcpClient = state.mcpClients!.find((c) => c.id === id)!;
    const callTool = mcpClient.client.callTool as unknown as jest.Mock;
    expect(callTool).toHaveBeenCalledWith({ name: "search", arguments: { query: "hello" } });
  });

  it("wraps toolParams as {args:[...]} when toolArgs is absent", async () => {
    const { state, id } = await setupConnected();
    await run(
      { command: "call-tool", id, toolName: "search", toolParams: ["a", "b"] },
      state
    );
    const mcpClient = state.mcpClients!.find((c) => c.id === id)!;
    const callTool = mcpClient.client.callTool as unknown as jest.Mock;
    expect(callTool).toHaveBeenCalledWith({ name: "search", arguments: { args: ["a", "b"] } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//   Session round-trip + legacy normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe("McpCli — session round-trip", () => {
  it("rehydrates connections from mcp.yaml across fresh state", async () => {
    writeCatalog(dataRoot, []);
    const state1 = makeState({ sessionFolder });
    await run(
      { command: "add-connection", id: "remote", url: "https://host.example/mcp", transport: "http" },
      state1
    );

    // Simulate a new process / fresh ChatState hitting the same sessionFolder.
    const state2 = makeState({ sessionFolder });
    const result = await run({ command: "connections" }, state2);
    const data = result.data as Array<{ name: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("remote");
  });

  it("normalises legacy 'sse' mcp.yaml entries to 'http' on load", async () => {
    writeMcpYaml(sessionFolder, [
      {
        id: "legacy-uuid",
        serverName: "legacy",
        description: "old entry",
        url: "https://legacy.example/mcp",
        transport: "sse",
        status: "inactive",
      },
    ]);
    const state = makeState({ sessionFolder });
    const result = await run({ command: "connections" }, state);
    const data = result.data as Array<{ transport: string }>;
    expect(data[0].transport).toBe("http");
  });

  it("drops persisted websocket entries on load", async () => {
    writeMcpYaml(sessionFolder, [
      {
        id: "ws-uuid",
        serverName: "ws",
        description: "dropped",
        url: "wss://ws.example/",
        transport: "websocket",
        status: "inactive",
      },
    ]);
    const state = makeState({ sessionFolder });
    const result = await run({ command: "connections" }, state);
    expect(result.data).toEqual([]);
  });
});
