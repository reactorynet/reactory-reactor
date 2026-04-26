# MCP Macro — Test Plan

TDD plan for `macro.test.ts`. Covers the `McpCli` macro + session-config + load-clients together, since the macro exercises both.

## Scope & strategy

- **Integration surface**: macro ↔ session-config ↔ load-clients ↔ catalog file. Use real `fs`/`js-yaml` against a tempdir for `REACTORY_DATA` and `sessionFolder`.
- **External surface**: `@modelcontextprotocol/sdk` — mock the three transports + the `Client` class so we never hit the network or spawn processes.
- **Env gating**: tests that exercise stdio gating set/clear `process.env.REACTORY_MCP_STDIO_ENABLED` in `beforeEach`/`afterEach`.
- **State**: build a minimal `ChatState` stub inline (`context.log`, `authToken`, `mcpClients`, `sessionFolder`). Avoid `TestContext.ts` since it pulls in `ReactoryContextProvider` and its service dependencies.

## Cases

### `available`
- [x] returns `{ success: false }` when `REACTORY_DATA` is unset
- [x] returns `{ success: false }` when `available.yaml` is missing
- [x] returns enriched services (http + stdio) with `available` flag
- [x] stdio services show `available: false` when `REACTORY_MCP_STDIO_ENABLED` is unset on non-electron runtimes
- [x] stdio services show `available: true` when env var is `'true'`

### `add-connection` (http)
- [x] generates uuid, pushes to `state.mcpClients`, writes to `mcp.yaml`
- [x] dedupe: second call with same `id` returns `{ reused: true }`
- [x] `credentialsForwarded: true` when URL origin matches a catalog entry
- [x] `credentialsForwarded: false` when URL is not in catalog
- [x] returns error when `url` is missing

### `add-connection` (stdio)
- [x] fails with "stdio transport is disabled" when not allowed
- [x] fails when no catalog entry matches `id`
- [x] fails when catalog entry's transport is not stdio
- [x] fails when catalog entry is missing `command`
- [x] succeeds when env-gated + catalog entry valid; persists command/args to `mcp.yaml`

### `connections`
- [x] empty list when no connections
- [x] entries include transport kind after add-connection (http / stdio)

### `connect`
- [x] fails when client not found
- [x] fails when transport absent
- [x] success: calls `client.connect(transport)`; returns capabilities summary; updates `mcp.yaml` to `active`

### `call-tool`
- [x] fails when client not found
- [x] fails when tool name not in `listTools`
- [x] passes structured `toolArgs` to `client.callTool({ name, arguments })`
- [x] wraps `toolParams: string[]` as `{ args: [...] }` when `toolArgs` is absent

### Session round-trip
- [x] after `add-connection`, a second macro invocation re-hydrates from `mcp.yaml` (via `loadClientsFromSession`) and `add-connection` again dedupes

### Legacy normalisation
- [x] `mcp.yaml` written with `transport: sse` is read back as `transport: http`
- [x] `available.yaml` with `transport: sse` is normalised to `http` in the enriched list

## Out of scope

- True SDK transport behaviour (covered by the SDK's own tests).
- Network/process behaviour of real MCP servers.
- GraphQL/REST surface — this file is macro-only.
