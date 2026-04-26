# MCP Macro — Corrective Plan

Companion to `README.md`. Fixes are grouped by priority. Tick items as they land.

## P0 — Blocking bugs

- [x] **F1. Missing `fs` / `js-yaml` imports in `macro.ts`.**
  `getAvailable` calls `fs.existsSync`, `fs.readFileSync`, `yaml.load` with neither import. `import fs from 'fs'; import yaml from 'js-yaml';` at the top.
- [x] **F2. Missing `McpCliProps` import.**
  `macro.ts:434-435` references the type without importing. Add `import { McpCliProps } from './types';`.
- [x] **F3. `callTool` indexes wrong shape.**
  `const tool = tools.find(...)` → `tools.tools.find(...)`. `listTools()` returns `{ tools, ... }`.
- [x] **F4. `callTool` signature mismatch.**
  SDK signature is `callTool({ name, arguments })` — not positional. Replace `toolParams: string[]` with `toolArgs: Record<string, unknown>` and pass `{ name: toolName, arguments: toolArgs }`. Keep a `toolParams` back-compat fallback that wraps it in `{ args: toolParams }` only if `toolArgs` is absent.
- [x] **F5. Missing `await` on capability/prompt/resource listings.**
  `getCapabilities` / `getPrompts` / `getResources` return `Promise<unknown>[]` instead of resolved data. Use `Promise.all` over `mcpClients.map(async c => ...)`. Note: `getServerCapabilities()` is *sync* in the SDK (returns cached data) — no await needed, but should run after connect.
- [x] **F6. `connect` builds a bogus second transport from `transport.url`.**
  `StreamableHTTPClientTransport` has no public `url` field — rebuilding fails. Connect the already-constructed transport from `add-connection` directly: `await client.connect(transports.sse)`.
- [x] **F7. `transport.type` doesn't exist.**
  Log line reads `undefined`. Remove the `.type` reference, log the transport kind we actually picked (`'sse'|'stdio'|'websocket'`) from a local variable.
- [x] **F8. Dead `commandHandlers` map.**
  Lines 422-432 build a dispatch map that's never used (the real dispatch is the `switch`). Delete the map or route through it. Deleting is cheaper.
- [x] **F9. Unused imports.**
  `removeConnectionFromSession`, `InitializedNotification` — remove.
- [x] **F15. Macro description lies about `connect` args.**
  Description says `@mcp(connect, url)` but handler expects an id. Update the description block so the LLM doesn't emit wrong args.
- [x] **F16. `getTools` drops `id` when `format` alone is passed.**
  `getTools(id ? [id, format] : [format], state)` — when no id, `format` lands in the `id` slot. Pass a single options object (or always `[id ?? '', format]`).

## P1 — Usability / correctness

- [x] **F10. Security: bearer token forwarded to any user-supplied URL.**
  Require any URL passed to `add-connection` to be present in `available.yaml` unless caller has an `ADMIN` role. Also strip the `Authorization` header when the URL host isn't allowlisted.
- [x] **F11. Declared but unimplemented transports.**
  `stdio` and `websocket` appear in enums but only SSE/HTTP is wired. Either drop them from the enum (and `McpConnectionEntry.transport` type) or implement them. Short-term: drop from enum + comment the intent.
- [x] **F17. `toolParams: string[]` boxes the agent into string args.**
  Replace the tool schema with `toolArgs: object` so agents can send structured payloads (most MCP tools require that). Keep `toolParams` accepted for one release as deprecated.
- [x] **F18. Inconsistent error result shape.**
  Some handlers return `{ error: string }`, some bare strings, some throw. Define `type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }` and return it everywhere. Simplifies the outer switch's error sniffing.

## P2 — Cleanup / hardening

- [x] **F12. `addConnection` has no duplicate guard.**
  Same `id` called twice → two in-memory entries. Deduplicate on `name`/`id` before push.
- [x] **F13. `onclose`/`onerror` re-close the transport.**
  Removes the re-close to avoid event loops; SDK handles it.
- [x] **F14. Arbitrary `setTimeout` delays.**
  Drop the 500ms and 1000ms sleeps around connect — `await client.connect(transport)` already blocks until the initialize round-trip completes.
- [x] **F19. Logging split between `console.error` and `context.log`.**
  Normalise on `context.log(..., 'error')` so logs flow through the observability pipeline.
- [x] **F20. `loadClientsFromSession` resurrects stale 'active' entries.**
  When persisted status is `'active'` but no live transport exists, force a reconnect (or at least mark `inactive`) before the agent tries to use the handle.

## Rollout order

1. F1, F2 (macro won't even run without these)
2. F8, F9 (trivial cleanup, lets us see the real code)
3. F3, F4, F5, F6, F7 (core behaviour)
4. F15, F16 (agent-facing signals)
5. F18 (now that handlers work, normalise shape)
6. F11, F17 (schema changes — breaking, so release-note worthy)
7. F10 (security — ship once above are stable to avoid churn)
8. F12, F13, F14, F19, F20 (cleanup sweep)

## Status

All P0/P1/P2 items have landed. A follow-up phase aligning the transport story with MCP spec standards has also landed:

- **WebSocket transport removed** across `MCPClient.transports` (chat.ts), `McpCliProps.transport` (types.ts), `McpConnectionEntry.transport` (session-config.ts), and the LLM-facing tool schema (macro.ts). Not a spec-defined MCP transport; keeping it was misleading.
- **Renamed `sse` → `http`** in `MCPClient.transports` and the tool enum. Reflects that the code uses `StreamableHTTPClientTransport` per the 2025-03-26 MCP spec (which deprecated the old HTTP+SSE transport). Legacy `'sse'` values in stored `mcp.yaml` and `available.yaml` are normalised to `'http'` on load for back-compat.
- **Stdio transport added with gating.** `StdioClientTransport` is wired end-to-end. Allowed unconditionally when `process.versions.electron` is set (desktop shell); requires `REACTORY_MCP_STDIO_ENABLED=true` on server deployments. Command/args/env/cwd are always resolved from `available.yaml` — the agent passes only the catalog `id`, never the command payload.

Type-check is clean for all MCP-related files.

## Follow-ups

- ✅ Unit tests landed: `macro.test.ts` + `macro_plan.md`. 25 cases passing; covers `available`, http + stdio `add-connection`, dedup, credential allowlisting, `connect`, `call-tool` arg shaping, session round-trip, and legacy normalisation. Run with `bin/jest.sh reactory local "macro/mcp/macro.test.ts" --no-coverage`.
- The legacy `'sse'` value is accepted at read time; consider a one-shot migration pass to rewrite persisted files to `'http'` and then drop the alias.

## Testing notes

There is no existing test for the mcp macro. Before merging the P0 fixes, add a minimal unit test covering:

- `command: 'available'` with a temp `REACTORY_DATA` + fake `available.yaml`.
- `add-connection` → `connections` round-trip.
- `call-tool` invoked against a stubbed `Client` (mock `listTools`/`callTool`).

Test file path: `ai/macro/mcp/macro.test.ts`. TDD plan per CLAUDE.md: add `macro.test_plan.md` alongside.
