# MCP Client Macro (`mcp`)

The `mcp` macro lets a Reactory AI agent act as an **MCP (Model Context Protocol) client** — discovering, connecting to, and invoking tools/prompts/resources exposed by MCP servers.

Macro FQN: `reactor-macros.mcp@1.0.0`
Exposed tool name (to LLM): `mcp`
Registered roles: `USER`

## Files

| File | Purpose |
| --- | --- |
| `macro.ts` | The `McpCli` macro + tool registry. All command handlers live here. |
| `types.ts` | `McpCliProps` — the tool call parameter shape. |
| `session-config.ts` | Reads/writes `mcp.yaml` in the per-session folder so connections survive turn boundaries. |
| `load-clients.ts` | Rehydrates `state.mcpClients` from the session YAML at the start of every call. |
| `index.ts` | Exports the macro definition for registration. |

## Transports

| Kind | When to use | Security posture |
| --- | --- | --- |
| `http` | Remote MCP servers. Streamable HTTP per the MCP 2025-03-26 spec (what `StreamableHTTPClientTransport` implements). Default. | Auth headers only forwarded when the URL origin matches a catalog entry in `available.yaml`. |
| `stdio` | Local child-process MCP servers (filesystem, git, etc.). Required by most community servers. | Desktop/electron shells: always allowed. Cloud/server deployments: off by default — set `REACTORY_MCP_STDIO_ENABLED=true` to opt in. Command/args/env are resolved from `available.yaml` — the agent cannot spawn arbitrary processes. |

Legacy `sse` values in stored `mcp.yaml` or `available.yaml` are automatically normalised to `http` on load. WebSocket is **not** supported — it is not a spec-defined MCP transport.

## Data locations

- **Per-session connection state** — `<sessionFolder>/mcp.yaml`. Managed by `session-config.ts`.
- **Available MCP catalog** — `$REACTORY_DATA/profiles/reactor/mcp/available.yaml`. Curated by operators; drives both the URL allowlist (for http) and the command allowlist (for stdio).

### `available.yaml` schema

```yaml
version: "1.0"
services:
  # http service
  - id: my-remote-server
    name: My Remote Server
    description: ...
    transport: http
    url: https://host/mcp        # ${ENV_VAR:fallback} interpolation supported
    tags: [search]
    requiredEnvVars: [MY_TOKEN]
    autoConnect: false

  # stdio service (desktop / gated server only)
  - id: filesystem
    name: Filesystem MCP
    description: Read/write files in a sandboxed directory.
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/sandbox"]
    env:
      SOME_VAR: value
    cwd: /path/to/wd
    tags: [fs]
```

Stdio entries **must** set `command`. The agent cannot override `command`, `args`, `env`, or `cwd` at runtime — only the catalog can.

## Tool parameters

```ts
interface McpCliProps {
  command: 'capabilities' | 'prompts' | 'tools' | 'resources'
         | 'add-connection' | 'connect' | 'disconnect' | 'connections'
         | 'call-tool' | 'available';
  id?: string;                              // connection uuid (post-add) or catalog id (for add-connection)
  url?: string;                             // required for add-connection when transport='http'
  transport?: 'http' | 'stdio';             // default: http
  toolName?: string;                        // required for call-tool
  toolArgs?: Record<string, unknown>;       // structured arguments for call-tool (preferred)
  toolParams?: string[];                    // deprecated — wrapped as {args:[...]} when toolArgs absent
  format?: 'json' | 'text';                 // default: text
}
```

Every command returns `{ success, data?, error?, instructions }`. `instructions` is Markdown guidance the model reads to pick the next action.

## Commands

### `available`
List MCP services from `available.yaml`. Entries flag `connected` and `available` (false when stdio is gated off). Starting point when the agent has no connections yet.
```json
{ "command": "available" }
```

### `add-connection`
Register a new connection. Persists to `mcp.yaml`. Does **not** open the transport.

Http:
```json
{ "command": "add-connection", "id": "my-server", "url": "https://host/mcp", "transport": "http" }
```
Stdio (catalog id must exist with `transport: stdio`):
```json
{ "command": "add-connection", "id": "filesystem", "transport": "stdio" }
```
Returns the generated connection uuid — use it for every subsequent call.

### `connections`
List every registered connection (active and inactive). Default command when `command` is omitted.
```json
{ "command": "connections" }
```

### `connect`
Open the transport, run the MCP initialize handshake, and cache capabilities. Must run after `add-connection` or after a session restart.
```json
{ "command": "connect", "id": "<uuid>" }
```

### `disconnect`
Close the transport and mark the connection `inactive` in `mcp.yaml`.
```json
{ "command": "disconnect", "id": "<uuid>" }
```

### `capabilities` / `prompts` / `tools` / `resources`
Query the connected server. If `id` is omitted, the operation runs against every connected client.
```json
{ "command": "tools", "id": "<uuid>", "format": "json" }
```

### `call-tool`
Invoke a tool exposed by the remote server. `toolName` must match a name returned by `tools`. Prefer `toolArgs` (structured) over `toolParams`.
```json
{ "command": "call-tool", "id": "<uuid>", "toolName": "search", "toolArgs": { "query": "reactory" } }
```

## Typical agent flow

1. `available` — see what's on offer.
2. `add-connection` with the chosen service (id + url for http; id only for stdio).
3. `connect` with the returned uuid.
4. `tools` to list capabilities.
5. `call-tool` to execute.
6. `disconnect` when done (optional — sessions can be reused across turns via `mcp.yaml`).

## Security notes

- Bearer token and `x-client-key` / `x-client-pwd` headers are forwarded **only** to http URLs whose origin + path prefix matches an entry in `available.yaml`. Arbitrary user URLs do not receive credentials.
- Stdio spawns a local child process. Disabled by default on server deployments (`REACTORY_MCP_STDIO_ENABLED=true` required). Command/args/env/cwd are catalog-supplied; the agent cannot inject them.
- `mcp.yaml` is stored in the session folder; treat it as session-scoped secret-adjacent state.
- On every macro call, persisted `status: active` connections are reset to `inactive` before rehydration — a server restart invalidates the handle and the agent must `connect` again.

## Runtime gating summary

| Runtime | http | stdio |
| --- | --- | --- |
| Reactory cloud/server (default) | ✅ | ❌ until `REACTORY_MCP_STDIO_ENABLED=true` |
| Reactory desktop / electron shell | ✅ | ✅ |
