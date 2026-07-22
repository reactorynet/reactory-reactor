# Structured Output & Augmented Provider Config — Implementation Plan

**Status:** In progress — spine + all four providers implemented & unit-tested (see §9 Progress)
**Author:** (assessment) — 2026-07-21
**Scope:** `ReactorConversationService.sendMessage` → `executeProviderChat` → the four provider services (`OpenAIService`, `AnthropicService`, `GoogleAIService`, `OllamaAIService`) and the Bedrock variant.
**Goal:** Add an optional, normalized `providerConfig` to the chat pipeline so callers can request **structured output** (and other model-specific "augmented" capabilities — reasoning effort, sampling, tool choice, response modalities) in a provider-agnostic way, with each provider translating the request into its native mechanism.

---

## 1. Summary / verdict

The **orchestration spine is ready**: `providerConfig` threads cleanly from GraphQL → `sendMessage` → `executeProviderChat` → each provider's `chat()`. The **providers are not**: none read anything beyond a fixed set of params today, each builds its SDK payload differently, and the four SDKs express structured output four different ways. This is a moderate lift concentrated in the providers.

**The one trap:** `AIChatParams` (`types/model.types.ts:248-254`) has an `[key: string]: any` index signature, so passing `providerConfig` compiles fine — but **every provider destructures a closed field set and silently drops the rest**. The type system will not warn you the value never reached the payload. Each provider needs explicit wiring.

---

## 2. Prerequisites — verify SDK versions BEFORE coding

The native structured-output mechanism differs per SDK **version**, and two of the installed versions need checking:

| Package | `package.json` | Installed (node_modules) | Structured-output mechanism | Action |
|---|---|---|---|---|
| `openai` | `3.2.1` | `3.2.1` reported, **but code uses v4 API** (`new OpenAI()`, `this.ai.chat.completions.create` at `OpenAIService.ts:197,582`) | `response_format: { type: 'json_schema', json_schema: {...} }` requires **v4.55+** | **Resolve the discrepancy first.** v3.2.1 cannot satisfy the code already in the repo, so the true resolved version (likely via the module compiler / `__runtime__` node_modules) must be confirmed to be ≥ 4.55. If it is < 4.55, fall back to `response_format: { type: 'json_object' }` + schema-in-prompt, or upgrade. |
| `@anthropic-ai/sdk` | — | **`0.59.0`** | **No native `output_config.format`** at this version. Native structured outputs (`messages.parse` / `output_config`) require a much newer SDK. | Implement via **forced `tool_choice`** on a schema-tool (works on 0.59.0), OR upgrade the SDK. Do **not** write `output_config.format` against 0.59.0 — it will be ignored/rejected. |
| `@google/genai` | — | `1.24.0` | `generationConfig.responseMimeType` + `responseSchema` | Supported — no upgrade needed. |
| `ollama` | — | `0.6.3` | top-level `format` (`"json"` or a JSON-schema object) | Supported — no upgrade needed. |

> Confirm each version with `node -e "require('<pkg>/package.json').version"` in the **runtime** module tree, not just the repo root, given this project's folder-based module compile (`__runtime__` node_modules).

---

## 3. Proposed `providerConfig` shape (normalized)

Do **not** make this a raw pass-through — the four providers diverge too much. Use a normalized shape each provider translates, plus a per-provider escape hatch. This is also the single place to fold in the other augmented services (several are currently **hardcoded** and worth exposing).

```ts
// types/model.types.ts (new)
export interface ReactorProviderConfig {
  /** Constrain the model's output to a JSON Schema. */
  structuredOutput?: {
    /** JSON Schema (draft-07 subset). Object schemas should set additionalProperties:false. */
    schema: Record<string, any>;
    /** Name for the schema/tool (OpenAI json_schema.name, Anthropic tool name). Default "response". */
    name?: string;
    /** Strict schema adherence where supported (OpenAI strict, Anthropic input_schema). Default true. */
    strict?: boolean;
  };
  /** Reasoning/thinking depth. Maps to OpenAI reasoning_effort / Anthropic thinking budget / Gemini thinkingConfig. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Currently hardcoded per-provider — surfacing it here makes it configurable. */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** 'auto' | 'none' | force a specific tool. Interacts with structuredOutput (see §6.1). */
  toolChoice?: 'auto' | 'none' | { name: string };
  /** Gemini/OpenAI multimodal output. */
  responseModalities?: ('text' | 'image')[];
  /** Provider-specific escape hatch, shallow-merged into the SDK payload LAST. Use sparingly. */
  raw?: Record<string, any>;
}
```

Each provider ignores what it doesn't support (gated by capability — see §7). This keeps callers provider-agnostic.

---

## 4. The spine (low risk — do first, no behavior change)

`executeProviderChat` already spreads `{...chatArgs}` into each provider's `chat()`, so once `providerConfig` is on `chatArgs` it flows automatically. Changes, in order:

| # | Layer | File:line | Change |
|---|---|---|---|
| 1 | Type | `types/model.types.ts:248` | Add `providerConfig?: ReactorProviderConfig` to `AIChatParams` (explicit field alongside the index signature). Define `ReactorProviderConfig`. |
| 2 | GraphQL input | `graphql/schema/ReactorChat.graphql:458` (`ReactorSendMessageInput`) | Add `providerConfig: ReactorProviderConfigInput`. Define the input type modeled on the existing `ReactorProviderAuthOverrideInput` (`:495`). |
| 3 | Resolver | `graphql/resolvers/ReactorChat.ts:751, 919, 1174` | The resolver maps fields explicitly — add `providerConfig: args.message.providerConfig` at **all three** `sendMessage` call sites. |
| 4 | `sendMessage` | `ReactorConversationService.ts:3114` | Add `providerConfig?: ReactorProviderConfig` to the arg type; destructure it (`:3137`). |
| 5 | `executeProviderChat` | `ReactorConversationService.ts:2999-3013` | Add `providerConfig?` to the `chatArgs` param type. It already spreads into `chat()`. |
| 6 | Call sites | `ReactorConversationService.ts:3496, 3783, 4723, 4755` (+ `1558`) | Pass `providerConfig` through on the main path (`3496`), the AUTO tool-loop continuation (`3783`), and the `completeClientToolCalls` continuations (`4723`, `4755`). `1558` (compaction) and title generation are internal callers that keep working since the param is optional; optionally use `structuredOutput` there later. |

After step 6, the value reaches every `chat()` — but each provider still drops it until §5 is done.

---

## 5. Per-provider wiring (the real work)

### 5.1 OpenAI (`OpenAIService.ts`) — serves openai, x-ai, copilot, azure-openai — **Low**

- Payload built in **one** place: `createPrompt()` returns at `OpenAIService.ts:306-317`. Streaming spreads `...prompt` (`:372-376`), non-streaming passes it straight (`:582`) — so **one injection point covers both paths**.
- Steps:
  1. Extend `chat()` destructure (`:676-686`) to read `providerConfig` off `params`.
  2. Thread it into `createPrompt(message)` (`:229-231`) — signature currently takes only `message`.
  3. In the return objects (`:306-317`) add, when `providerConfig.structuredOutput` is set:
     ```ts
     response_format: {
       type: 'json_schema',
       json_schema: { name, strict, schema },
     }
     ```
     plus `temperature`, `top_p`, `max_tokens`, `reasoning_effort` from the normalized config where present. Merge `providerConfig.raw` last.
- Note: `parallel_tool_calls`/`tool_choice: "auto"` are already set at `:310-311` when tools are attached — reconcile with `providerConfig.toolChoice` (see §6.1).

### 5.2 Ollama (`OllamaAIService.ts`) — native `format` — **Low–Med**

- **Two** hand-built payloads: streaming `:203-208`, non-streaming `:345-350`. Both must be edited (no shared builder — main duplication risk).
- Steps:
  1. Extend `chat()` destructure (`:470-476`) to read `providerConfig`.
  2. Thread through `handleStreamingRequest` (args object `:170-177`) and `handleNonStreamingRequest` (positional `:340-344`) from the dispatch at `:500-511`.
  3. Add `format: providerConfig.structuredOutput.schema` (or `"json"` if no schema) to both payloads; add an `options` object for `temperature`/`top_p`/etc. (none exists today).
- Response arrives as a JSON string in `message.content` — no parsing today (`:322/375`); leave raw or parse (see §6.2).

### 5.3 Gemini (`GoogleAIService.ts`) — native `responseSchema` — **Medium**

- Shared session config `chatConfig` assembled at `GoogleAIService.ts:869-900`, used by both stream and non-stream via `chats.create` (`:902-906`) — **single injection point** for `generationConfig`-level options.
- Steps:
  1. Extend `chat()` destructure (`:1844-1854`) to read `providerConfig`; stash on `chatState` or thread through `getAIResponse` (`:1356`) → `createChatSession` (`:723`).
  2. In `chatConfig` (`:869-900`) add `responseMimeType: "application/json"` + `responseSchema` when `structuredOutput` is set. Make `temperature`/`topP`/penalties (hardcoded `:872-876`) honor the normalized config.
  3. Convert the caller's JSON Schema to a Gemini `Schema` — **reuse the existing converters** `handleObjectProperties`/`toPropertiesRecord`/`handleArrayItems` (`:324-420`). **Caveat:** those downgrade property-less `object` types to `STRING` (a function-calling workaround, `:334-351`) — add a variant that preserves objects for strict response schemas.
- **Constraint:** Gemini cannot combine `responseSchema` with function-calling `tools`. The tool gating (`:886-895`) must **disable tools** when `structuredOutput` is requested (see §6.1).

### 5.4 Anthropic (`AnthropicService.ts`) + Bedrock (`AWSBedrockService.ts`) — **High**

- SDK `@anthropic-ai/sdk@0.59.0` has **no native `response_format`** → use **forced tool_choice**.
- Single shared builder `buildRequestParams()` at `AnthropicService.ts:601-639`, used by both stream (`:667`) and non-stream (`:857`) — one injection point for the request shape. `tool_choice` is **not set anywhere today** and must be added.
- Steps:
  1. Extend `chat()` destructure (`:1087-1097`) to read `providerConfig`; thread into `getAIResponse`/`buildRequestParams`.
  2. In `buildRequestParams` (`:601-639`), when `structuredOutput` is set:
     - Inject a synthetic tool whose `input_schema` is the caller's schema (reuse `convertToolsToAnthropicFormat` shape, `:99-109`).
     - Set `params.tool_choice = { type: 'tool', name: <schema tool name> }`.
     - Map `reasoningEffort` → thinking budget (note `:596-599` uses the **deprecated** `{type:'enabled', budget_tokens}` gated on hardcoded model substrings; the default model is `claude-sonnet-4-5-20250929` — revisit this gate).
  3. **Critical — bypass the tool-execution loop for the schema tool.** The AUTO loop (`runToolLoop`, `:839-938`) and the streaming finalize (`:740-764`) will try to *execute* the emitted `tool_use` as a macro. Add a bypass so the schema tool's `input` is returned as the structured result instead of being dispatched to `macroService.executeTool`. This is the hardest part of the whole plan.
  4. Structured JSON streams as `input_json_delta` accumulated into `block.inputJson` (`:735-737`) — surface it as the result on completion.
- **Bedrock** (`AWSBedrockService.ts`) has **three** separate inline `InvokeModel` body-construction sites (`:293-304, :379-392, :441-454`) with no shared builder and passes no tools/tool_choice today — treat as a follow-up sub-task; all three sites need the schema-tool + tool_choice added.

---

## 6. Cross-cutting concerns

### 6.1 Tool-calling conflict (design decision — resolve up front)
Structured output is mutually exclusive with tools on **Gemini**, and collides with the server-side AUTO tool loop on **Anthropic**. This pipeline is heavily macro/tool-oriented. **Decision:** when `providerConfig.structuredOutput` is present, **disable tools for that turn** unless the caller explicitly sets `toolChoice`. Document this; enforce it in each provider before attaching tools.

### 6.2 Response side is pass-through only
All adapters (`ReactorProviderService.ts:89-190`) return `content` as a raw string; the GraphQL `content` field is `String`. Structured output arrives as a **JSON string**. **Decision needed:** either (a) leave parsing to the client, or (b) `JSON.parse` + validate server-side and surface a new parsed GraphQL field (e.g. `structuredContent: JSON`). Recommend (a) for v1, (b) as a follow-up.

### 6.3 Capability gating
`providers.yaml` already carries per-model `capabilities: []` and `supportedTools: []`, consumed via `resolveModelConfig()`/`modelSupportsFunctionCalling()` (`OpenAIService.ts:85-113`). **Add a `structured-output` capability** and gate on it (mirror the function-calling check) so a request to a non-supporting model degrades gracefully (clear error or ignore) instead of failing at the SDK layer. Add the capability to the models that support it in `ai/providers/providers.yaml`.

### 6.4 Streaming semantics
With SSE, structured JSON streams as partial fragments; the parsed object is only meaningful at completion. All providers build one payload shared across stream/non-stream (except Ollama's two sites), so config flows to both — but the client must buffer until done.

---

## 7. Suggested sequencing

1. **Prerequisites (§2)** — confirm the resolved `openai` and `@anthropic-ai/sdk` versions. This gates the OpenAI and Anthropic mechanisms.
2. **Spine + `ReactorProviderConfig` type + GraphQL input (§4)** — no behavior change; get the value flowing end-to-end.
3. **OpenAI (§5.1)** — native, single injection, lowest risk; proves the path end-to-end.
4. **Ollama (§5.2) + Gemini (§5.3)** — native, medium.
5. **Anthropic (§5.4)** — forced-tool + tool-loop bypass is the hardest; Bedrock is a further sub-task.
6. **Capability declarations + gating (§6.3).**
7. **Response-side parsing decision (§6.2).**

---

## 8. Key file/line index

- `sendMessage`: `ReactorConversationService.ts:3114`
- `executeProviderChat` (dispatch): `ReactorConversationService.ts:2999-3047`
- `executeProviderChat` call sites: `:1558, :3496, :3783, :4723, :4755`
- `AIChatParams`: `types/model.types.ts:248-254`
- GraphQL input: `graphql/schema/ReactorChat.graphql:458` (+ auth-override model at `:495`)
- Resolver call sites: `graphql/resolvers/ReactorChat.ts:751, 919, 1174`
- OpenAI payload: `providers/OpenAIService.ts:306-317` (build), `:372-376`/`:582` (send), `:676-686` (chat), `:85-113` (capability)
- Anthropic payload: `providers/AnthropicService.ts:601-639` (build), `:667`/`:857` (send), `:1087-1097` (chat), `:839-938` (tool loop to bypass)
- Gemini config: `providers/GoogleAIService.ts:869-906` (build), `:1844-1854` (chat), `:324-420` (schema converters)
- Ollama payloads: `providers/OllamaAIService.ts:203-208` + `:345-350`, `:470-476` (chat)
- Bedrock bodies: `providers/AWSBedrockService.ts:293-304, :379-392, :441-454`
- Adapters (response shaping): `ReactorProviderService.ts:89-190`
- Model registry: `ai/providers/providers.yaml`

---

## 9. Progress

Prerequisites resolved (versions in the reactor module runtime tree):
`openai@4.87.3` (native `json_schema` ✓), `@anthropic-ai/sdk@0.59.0` (forced `tool_choice`),
`@google/genai@1.24.0` (`responseJsonSchema` — avoids the Schema-converter downgrade caveat),
`ollama@0.6.3` (`format`). Note: the reactor module is a **nested git repo** — commit its
changes from `src/modules/reactory-reactor`, not the parent repo.

### Done
- **Types** — `ReactorProviderConfig` / `ReactorStructuredOutput` + `AIChatParams.providerConfig` (`types/model.types.ts`).
- **Translators** — pure, unit-tested per-provider translators + `structuredOutputDisablesTools`
  (`providers/providerConfigTranslators.ts`). 25 unit tests.
- **Spine** — `providerConfig` threaded GraphQL input → resolver (`ReactorSendMessage`) →
  `sendMessage` → `executeProviderChat` → each provider `chat()`. GraphQL:
  `ReactorProviderConfigInput` / `ReactorStructuredOutputInput` in `ReactorProviders.graphql`.
- **OpenAI** — `response_format.json_schema` + sampling/reasoning/tool_choice via `createPrompt`;
  tools suppressed on structured output; covers stream + non-stream (shared `...prompt`). 6 tests.
- **Ollama** — top-level `format` + `options`, both payload sites; tools suppressed. 5 tests.
- **Gemini** — `responseMimeType` + `responseJsonSchema` merged into session `chatConfig`;
  tools suppressed. 3 integration tests + translator tests.
- **Anthropic** — forced schema-tool + `tool_choice` in `buildRequestParams`; thinking disabled
  for structured output / sampling overrides; **tool-loop terminal bypass** in `runToolLoop`
  (schema `tool_use` returned as JSON content, not executed) and streaming `content_block_stop`. 5 tests.

- **Capability gating (§6.3)** — `ReactorProviderService.modelSupportsStructuredOutput(providerId, modelId)`:
  unwired providers (amazon/cohere/deepseek) return false; wired providers default supported unless the
  model's registry `capabilities` opt out with `no-structured-output` (Option B — opt-out, not mass opt-in,
  given 86 models). Flagship models of each wired provider flagged `structured-output` in `providers.yaml`
  for discoverability. Gated in `executeProviderChat` — a clear, non-retryable error fails fast instead of
  an opaque SDK 400. 8 tests.
- **Response-side parsing (§6.2)** — `parseStructuredContent` (pure) + `attachStructuredContent` on the
  service parse the JSON body and expose it as a new **`structuredContent: Any`** field on the
  `ReactorChatMessage` GraphQL type (raw string still on `content`); invalid JSON leaves it unset. Applied
  to both `sendMessage` return paths. 10 tests.

**62 new tests, all passing. Zero regressions** (the 6 failing `OpenAIService.streaming` factory-method
tests are pre-existing — verified failing identically with these changes reverted). No new type errors;
`providers.yaml` still loads (auth test green).

### Not yet done (follow-ups)
- **SSE structured field** — the parsed `structuredContent` is attached on the non-streaming GraphQL return;
  in SSE mode the JSON still arrives as the streamed `content` string (client parses). Wiring a parsed field
  into the completion event is a follow-up.
- **Unwired call sites** — the two voice resolvers (`ReactorAskQuestionAudio`, voice input) and the
  `completeClientToolCalls` continuations (`ReactorConversationService.ts` ~4727/4759) don't forward
  `providerConfig`. Low priority — structured output disables tools, so the client-tool path is rarely hit.
- **Bedrock (`AWSBedrockService.ts`)** — three inline `InvokeModel` bodies; not yet wired.
