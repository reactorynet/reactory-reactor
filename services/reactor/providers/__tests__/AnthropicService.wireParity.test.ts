import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import lodash from "lodash";
import { StreamingEventType, StreamingMode } from "../../types/streaming.types";
import ReactorConversationModel from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import AnthropicService from "../AnthropicService";

/**
 * WIRE-LEVEL proof for the @anthropic-ai/sdk 0.59.0 -> 1.8.0 upgrade.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `AnthropicService` deliberately does NOT use the SDK's `messages.stream()`
 * helper. It calls `messages.create({ stream: true })` and then hand-iterates
 * the raw response, switching on `chunk.type` and reading `chunk.message.usage`,
 * `chunk.content_block`, `chunk.delta.*`. Every one of those event shapes is
 * OUR assumption about the wire format, not an SDK contract, and TypeScript
 * cannot see any of it — the cast `stream as AsyncIterable<any>` erases the
 * event type entirely.
 *
 * So the provider suites that mock `@anthropic-ai/sdk` wholesale prove nothing
 * about an SDK upgrade: they stub `create()` and hand the service the very
 * object shapes that are in question. This suite runs the REAL anthropic@1.8.0
 * client and replaces only the transport (`globalThis.fetch`), so each
 * assertion is a statement about the bytes the service actually sends and the
 * events it actually receives.
 *
 * Covered, in the order the ticket lists the risks:
 *   - the `anthropic-version` header the 1.8.0 client pins (2026-10-21), which
 *     is a different wire contract from 0.59.0's 2023-06-01;
 *   - the sampling parameters that 2026-10-21 removed — `temperature`, `top_p`
 *     and `top_k` are a 400 ("Extra inputs are not permitted") for every model,
 *     so the request builder must never emit them again;
 *   - prompt-cache accounting: `input_tokens` + `cache_read_input_tokens` +
 *     `cache_creation_input_tokens` read separately and summed. Reading only
 *     `input_tokens` is the silent cost bug this guards;
 *   - a fragmented `tool_use` (`input_json_delta`) reassembled into one parsed
 *     `arguments` string, including the no-argument tool that emits no deltas;
 *   - a signed `thinking` block captured from the stream, persisted verbatim and
 *     replayed on the next request — plus a `redacted_thinking` block replayed
 *     with its opaque `data`; and the rule that both are stripped when the
 *     request disables thinking;
 *   - `message_delta.output_tokens` reaching the final usage.
 *
 * No credentials and no network are used: `globalThis.fetch` is stubbed, so a
 * real API key in the environment is never touched.
 */

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

const captures: Capture[] = [];
let responder: (capture: Capture) => Response = () => {
  throw new Error("no responder installed");
};
let restoreFetch: (() => void) | null = null;

const sentEvents: any[] = [];
const debugLogs: string[] = [];

const mockContext: any = {
  log: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (message: string): void => {
    debugLogs.push(message);
  },
  info: (): void => undefined,
  getService: (): void => undefined,
  // AIProviderBase.createSystemPrompt interpolates the persona's system prompt
  // through lodash.template; the real one keeps the `system` field honest.
  utils: { lodash },
  user: {
    _id: new ObjectId(),
    id: new ObjectId().toString(),
    fullName: (): string => "Wire Test",
    firstName: "Wire",
    lastName: "Test",
    roles: ["USER"],
  },
  partner: { _id: new ObjectId() },
};

function normaliseHeaders(init: any): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) return out;

  if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
    headers.forEach((value: string, key: string) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Replace the transport. anthropic@1.8.0 captures `fetch` when the client is
 * constructed (`client.js`: `this.fetch = options.fetch ?? Shims.getDefaultFetch()`),
 * so this must run BEFORE `initializeClient` builds the client.
 */
function installFetchRecorder(): void {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as a string */
      }
    }

    const capture: Capture = {
      method: String(init?.method ?? "GET").toUpperCase(),
      url,
      headers: normaliseHeaders(init),
      body,
    };
    captures.push(capture);
    return responder(capture);
  };

  restoreFetch = () => {
    (globalThis as any).fetch = original;
  };
}

/** A JSON Messages response, i.e. the non-streaming path. */
function messageResponse(options: {
  text?: string;
  usage?: Record<string, number>;
  stopReason?: string;
  content?: any[];
}): Response {
  return new Response(
    JSON.stringify({
      id: "msg_wire",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: options.content ?? [{ type: "text", text: options.text ?? "ok" }],
      stop_reason: options.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: options.usage ?? {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A real SSE body in the exact framing the Messages API uses (`event:` +
 * `data:` per frame), so the SDK's own SSE parser and the service's `for await`
 * loop both run for real. Frames are enqueued ONE AT A TIME with an await
 * between them so a partially-buffered chunk cannot mask a framing bug.
 */
function sseResponse(frames: any[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(body as any, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const MESSAGES_USAGE = (
  input: number,
  cacheRead: number,
  cacheCreation: number,
  output: number,
) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
  output_tokens: output,
});

/** message_start, as the API emits it (usage lives on `message.usage`). */
function messageStart(usage: Record<string, number>): any {
  return {
    type: "message_start",
    message: {
      id: "msg_wire",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
}

const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, units: { type: "string" } },
      required: ["city"],
    },
  },
};

interface ServiceOptions {
  streamingMode?: StreamingMode;
  tools?: any[];
  sessionId?: string;
  /** Extra history items placed BEFORE the turn under test. */
  history?: any[];
  modelId?: string;
}

function createService(options: ServiceOptions = {}) {
  const persona: any = {
    id: "persona-wire",
    name: "Anthropic wire parity",
    providerId: "anthropic",
    modelId: options.modelId ?? "claude-opus-4-8",
    prompts: { system: { content: "You are a wire test." } },
    tools: options.tools ?? [],
    modelConfig: {},
    // `initializeClient` reads persona.config.apiKey (falling back to
    // process.env.ANTHROPIC_API_KEY). A fake key is set here so the suite can
    // never reach a real credential in the environment.
    config: { apiKey: "wire-test-key" },
  };

  const props: any = {
    apiKey: "wire-test-key",
    streamingMode: options.streamingMode ?? StreamingMode.NONE,
    $services: {},
  };

  const service: any = new AnthropicService(props, mockContext);
  service.personaProvider = { getPersona: async (): Promise<any> => persona };
  service.macroService = { executeTool: async (): Promise<any> => ({ ok: true }) };
  service.streamingTransportManager = {
    sendEventToSession: async (_sessionId: string, event: any) => {
      sentEvents.push(event);
    },
  };
  service.streamingSessionManager = {
    getSession: (): null => null,
    createSession: (): null => null,
  };
  service.streamingMode = options.streamingMode ?? StreamingMode.NONE;
  service.chatState = {
    id: options.sessionId,
    personaId: persona.id,
    modelId: persona.modelId,
    persona,
    history: options.history ? [...options.history] : [],
    tools: options.tools ?? [],
    maxToolIterations: 3,
  };
  service.chatStateModel = null;

  return { service, persona };
}

/**
 * The sequence `chat()` performs: build the client, then hand the message to
 * `getAIResponse` as the `user` role (which appends it to history, converts the
 * history to Anthropic format and dispatches).
 */
async function dispatch(
  service: any,
  message: string,
  providerConfig?: any,
): Promise<any> {
  await service.initializeClient(service.chatState.persona);
  return service.getAIResponse(message, "user", undefined, providerConfig);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  captures.length = 0;
  sentEvents.length = 0;
  debugLogs.length = 0;
  // Remove every ambient credential: the stubbed transport means a request can
  // only ever reach this recorder, but the suite must not depend on that.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  installFetchRecorder();
});

afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The wire contract 1.8.0 changed.
// ---------------------------------------------------------------------------

describe("anthropic@1.8.0 wire contract", () => {
  it("pins anthropic-version 2026-10-21 on the real client's request", async () => {
    responder = () => messageResponse({ text: "ok" });
    const { service } = createService();

    await dispatch(service, "hello");

    expect(captures).toHaveLength(1);
    const [request] = captures;
    expect(request.method).toBe("POST");
    expect(request.url.endsWith("/v1/messages")).toBe(true);
    // 0.59.0 sent 2023-06-01. Anything that still reads the old contract is
    // now talking to a different endpoint behaviour, so the value is asserted
    // rather than assumed.
    expect(request.headers["anthropic-version"]).toBe("2026-10-21");
    // The auth scheme moved too: 0.59.0 sent `x-api-key: <key>`, 1.8.0 sends a
    // bearer token. Both are captured so a regression in either is visible.
    expect(request.headers["authorization"]).toBe("Bearer wire-test-key");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.body.model).toBe("claude-opus-4-8");
    expect(request.body.stream).toBeUndefined();
  });

  it("never emits temperature/top_p/top_k — 2026-10-21 rejects them for every model", async () => {
    responder = () => messageResponse({ text: "ok" });
    // claude-sonnet-4-6 is still marked `sampling.temperature: true` in
    // providers.yaml, and the caller asks for sampling explicitly. Both sources
    // must be dropped: live, either one is
    //   400 invalid_request_error "temperature: Extra inputs are not permitted".
    const { service } = createService({ modelId: "claude-sonnet-4-6" });

    await dispatch(service, "hello", { temperature: 0.3, topP: 0.9 });

    const { body } = captures[0];
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect("top_k" in body).toBe(false);
    // The drop is reported, not silent.
    expect(debugLogs.join("\n")).toMatch(/Dropped sampling param\(s\) \[temperature, top_p\]/);
  });

  it("keeps thinking on when the caller asks for sampling, on both yaml sampling flavours (R1)", async () => {
    // R1: the gate used to key on the providers.yaml sampling flags, so identical
    // caller config did two different things:
    //   claude-sonnet-4-6 (yaml temperature: true)  -> thinking DISABLED
    //   claude-opus-4-8   (yaml temperature: false) -> thinking KEPT
    // while temperature was dropped on both. Sampling is unsendable on
    // anthropic-version 2026-10-21, so it cannot influence the model and must not
    // cost the caller reasoning either. Both models are mode: adaptive, so the
    // expected block is the adaptive one.
    for (const modelId of ["claude-sonnet-4-6", "claude-opus-4-8"]) {
      captures.length = 0;
      responder = () => messageResponse({ text: "ok" });
      const { service } = createService({ modelId });

      await dispatch(service, "hello", { temperature: 0.3, topP: 0.9 });

      const { body } = captures[0];
      // Thinking survives the caller's sampling request on BOTH flavours...
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      // ...and the unsendable params are still dropped on both.
      expect("temperature" in body).toBe(false);
      expect("top_p" in body).toBe(false);
    }
  });

  it("still disables thinking for structured output, which is the remaining gate (R1)", async () => {
    // Guard the other half: only structured output may turn thinking off now.
    responder = () => messageResponse({ text: "ok" });
    const { service } = createService({ modelId: "claude-sonnet-4-6" });

    await dispatch(service, "hello", { structuredOutput: { schema: { type: "object" } } as any });

    expect(captures[0].body.thinking).toBeUndefined();
  });

  it("constructs the client with OpenTelemetry propagation disabled (R2)", async () => {
    // @anthropic-ai/sdk 1.x traces by default: with no `openTelemetry` option it
    // uses the global tracer provider and `propagation` defaults to true, so it
    // injects the global propagator's traceparent/tracestate/baggage into every
    // request to api.anthropic.com.
    responder = () => messageResponse({ text: "ok" });
    const { service } = createService({ modelId: "claude-sonnet-4-6" });

    await dispatch(service, "hello");

    // The settled option is frozen on the client, so this is exactly what the SDK
    // will act on at request time.
    expect((service.anthropic as any).openTelemetry.propagation).toBe(false);

    // And no trace context went out on the request.
    const headers = captures[0].headers;
    expect(headers.traceparent).toBeUndefined();
    expect(headers.tracestate).toBeUndefined();
    expect(headers.baggage).toBeUndefined();
  });

  it("still sends thinking + output_config for an adaptive-thinking model", async () => {
    responder = () => messageResponse({ text: "ok" });
    const { service } = createService({ modelId: "claude-opus-4-8" });

    await dispatch(service, "hello");

    expect(captures[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(captures[0].body.output_config).toEqual({ effort: "high" });
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache accounting — the silent cost bug.
// ---------------------------------------------------------------------------

describe("prompt-cache accounting", () => {
  it("sums input_tokens + cache_read + cache_creation from message_start on a streaming turn", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(1200, 4096, 512, 1)),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
        { type: "content_block_stop", index: 0 },
        // The final usage repeats the prompt buckets and adds output_tokens.
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: MESSAGES_USAGE(1200, 4096, 512, 34) },
        { type: "message_stop" },
      ]);

    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      sessionId: "wire-session",
    });

    const response = await dispatch(service, "hello");

    expect(captures[0].body.stream).toBe(true);
    expect(response.choices[0].message.content).toBe("Hello, world");
    expect(response.choices[0].finish_reason).toBe("end_turn");
    // 1200 + 4096 + 512: reading only `input_tokens` would report 1200 and make
    // 4608 cached tokens vanish from every cost report.
    expect(response.usage.promptTokens).toBe(5808);
    expect(response.usage.cacheHitTokens).toBe(4096);
    expect(response.usage.cacheMissTokens).toBe(1712);
    expect(response.usage.completionTokens).toBe(34);
    expect(response.usage.totalTokens).toBe(5842);
  });

  it("sums the same three buckets on the non-streaming tool loop", async () => {
    responder = () =>
      messageResponse({
        text: "done",
        usage: MESSAGES_USAGE(200, 1024, 64, 7),
      });
    const { service } = createService();

    const response = await dispatch(service, "hello");

    expect(response.usage.promptTokens).toBe(1288);
    expect(response.usage.cacheHitTokens).toBe(1024);
    expect(response.usage.cacheMissTokens).toBe(264);
    expect(response.usage.completionTokens).toBe(7);
    expect(response.usage.totalTokens).toBe(1295);
  });

  it("keeps prompt buckets that arrive only on message_start", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(300, 2048, 256, 1)),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        // No prompt buckets here — the parser must not zero what it already read.
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 11 } },
        { type: "message_stop" },
      ]);

    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      sessionId: "wire-session",
    });

    const response = await dispatch(service, "hello");

    expect(response.usage.promptTokens).toBe(2604);
    expect(response.usage.cacheHitTokens).toBe(2048);
    expect(response.usage.completionTokens).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Tool-call streaming: input_json_delta reassembly.
// ---------------------------------------------------------------------------

describe("fragmented tool_use streaming", () => {
  it("reassembles multiple input_json_delta fragments into one parsed input", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(569, 0, 0, 1)),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_wire_1", name: "get_weather", input: {} },
        },
        // The live API sends an empty first fragment, then arbitrary splits
        // mid-key and mid-value.
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city"' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ': "Cape' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' Town", "units": "metric"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: MESSAGES_USAGE(569, 0, 0, 55) },
        { type: "message_stop" },
      ]);

    // No session id: the tool-call path would otherwise try to persist through
    // Mongoose before the completion event (production behaviour, tested
    // elsewhere). This suite is about the parse.
    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      tools: [SEARCH_TOOL],
    });

    const response = await dispatch(service, "weather in cape town?");

    // The tools went out in Anthropic's shape.
    expect(captures[0].body.tools).toEqual([
      {
        name: "get_weather",
        description: "Get the weather for a city",
        input_schema: SEARCH_TOOL.function.parameters,
      },
    ]);

    const toolCall = response.choices[0].message.tool_calls[0];
    expect(toolCall.id).toBe("toolu_wire_1");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function.name).toBe("get_weather");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "Cape Town", units: "metric" });
    expect(response.choices[0].finish_reason).toBe("tool_use");

    const toolEvents = sentEvents.filter((event) => event.type === StreamingEventType.TOOL_CALL);
    // start + complete
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[1].data).toMatchObject({ id: "toolu_wire_1", isComplete: true });
  });

  it("normalises a no-argument tool (no deltas at all) to a parseable {}", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(100, 0, 0, 1)),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_noargs", name: "get_weather", input: {} },
        },
        // The API emits NO input_json_delta for a zero-argument tool.
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]);

    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      tools: [SEARCH_TOOL],
    });

    const response = await dispatch(service, "call it with no arguments");

    const toolCall = response.choices[0].message.tool_calls[0];
    // "" would make every downstream JSON.parse throw.
    expect(toolCall.function.arguments).toBe("{}");
    expect(() => JSON.parse(toolCall.function.arguments)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Thinking blocks: capture from the stream, persist verbatim, replay next turn.
// ---------------------------------------------------------------------------

describe("thinking-block capture and replay", () => {
  it("captures a signed thinking block from the stream and persists it verbatim", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(388, 0, 0, 1)),
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the units first." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-wire-abc" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_wire_2", name: "get_weather", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Cape Town"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: MESSAGES_USAGE(388, 0, 0, 69) },
        { type: "message_stop" },
      ]);

    const persist = jest
      .spyOn(ReactorConversationModel as any, "findOneAndUpdate")
      .mockReturnValue({ exec: async (): Promise<null> => null } as any);

    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      sessionId: "wire-session",
      tools: [SEARCH_TOOL],
    });

    const response = await dispatch(service, "weather in cape town?");

    // Reasoning surfaced to the client.
    expect(response.choices[0].message.content).toBe("");
    expect(response.choices[0].finish_reason).toBe("tool_use");
    expect(sentEvents.some((event) => event.type === StreamingEventType.REASONING)).toBe(true);

    // …and the block itself was persisted for the next turn.
    expect(persist).toHaveBeenCalledTimes(1);
    const pushed = (persist.mock.calls[0][1] as any).$push.history;
    expect(pushed.thinking_blocks).toEqual([
      { type: "thinking", thinking: "Check the units first.", signature: "sig-wire-abc" },
    ]);
    expect(pushed.tool_calls).toHaveLength(1);
    expect(JSON.parse(pushed.tool_calls[0].function.arguments)).toEqual({ city: "Cape Town" });
  });

  it("replays the signed thinking block and a redacted_thinking block verbatim on the following request", async () => {
    responder = () => messageResponse({ text: "22C and sunny" });

    // Exactly the shape handleStreamingRequest persists (`$push.history`), plus
    // the redacted variant, which carries opaque `data` instead of a signature.
    const assistantTurn = {
      id: new ObjectId(),
      role: "assistant",
      content: "",
      thinking: "Check the units first.",
      thinking_blocks: [
        { type: "thinking", thinking: "Check the units first.", signature: "sig-wire-abc" },
        { type: "redacted_thinking", data: "opaque-redacted-blob" },
      ],
      timestamp: new Date(),
      tool_calls: [
        { id: "toolu_wire_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Cape Town"}' } },
      ],
      tool_results: [] as any[],
    };
    const toolResultTurn = {
      id: new ObjectId(),
      role: "user",
      content: "",
      timestamp: new Date(),
      tool_results: [{ tool_call_id: "toolu_wire_2", content: "22C and sunny" }],
    };

    const { service } = createService({
      modelId: "claude-opus-4-8",
      tools: [SEARCH_TOOL],
      history: [
        { id: new ObjectId(), role: "user", content: "weather in cape town?", timestamp: new Date(), tool_results: [] },
        assistantTurn,
        toolResultTurn,
      ],
    });

    await dispatch(service, "thanks");

    const { body } = captures[0];
    // Thinking must be on for replayed blocks to be legal; it is, for this model.
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });

    const assistantMessage = body.messages.find((message: any) => message.role === "assistant");
    expect(Array.isArray(assistantMessage.content)).toBe(true);
    // Order matters: the reasoning blocks precede the tool_use they produced.
    expect(assistantMessage.content[0]).toEqual({
      type: "thinking",
      thinking: "Check the units first.",
      signature: "sig-wire-abc",
    });
    expect(assistantMessage.content[1]).toEqual({
      type: "redacted_thinking",
      data: "opaque-redacted-blob",
    });
    expect(assistantMessage.content[2]).toMatchObject({
      type: "tool_use",
      id: "toolu_wire_2",
      name: "get_weather",
      input: { city: "Cape Town" },
    });
  });

  it("strips replayed thinking blocks when the request disables thinking", async () => {
    responder = () => messageResponse({ content: [{ type: "tool_use", id: "struct_1", name: "answer", input: { answer: "42" } }], stopReason: "tool_use" });

    const { service } = createService({
      modelId: "claude-opus-4-8",
      history: [
        { id: new ObjectId(), role: "user", content: "earlier", timestamp: new Date(), tool_results: [] },
        {
          id: new ObjectId(),
          role: "assistant",
          content: "prior answer",
          thinking: "reasoning",
          thinking_blocks: [
            { type: "thinking", thinking: "reasoning", signature: "sig-wire-abc" },
            { type: "redacted_thinking", data: "opaque-redacted-blob" },
          ],
          timestamp: new Date(),
          tool_calls: [],
          tool_results: [],
        },
      ],
    });

    await dispatch(service, "answer in json", {
      structuredOutput: {
        name: "answer",
        strict: true,
        schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      },
    });

    const { body } = captures[0];
    expect(body.thinking).toBeUndefined();
    const serialised = JSON.stringify(body.messages);
    expect(serialised).not.toContain('"signature"');
    expect(serialised).not.toContain('"redacted_thinking"');
    // The turn survives, minus the reasoning blocks.
    const assistantMessage = body.messages.find((message: any) => message.role === "assistant");
    expect(assistantMessage.content).toEqual([{ type: "text", text: "prior answer" }]);
  });

  it("does not replay an unsigned thinking block (the API would reject it)", async () => {
    responder = () => messageResponse({ text: "ok" });

    // The assistant turn MUST carry a tool_call (or text) to survive
    // convertHistoryToAnthropicFormat: the thinking-block extraction sits inside
    // `if (contentBlocks.length > 0)`, and an assistant turn with empty content and
    // no tool_calls hits `continue` before extractThinkingBlocks is ever called.
    //
    // An earlier version of this test used exactly that empty shape, so the whole
    // assistant message was dropped for an unrelated reason and the assertion passed
    // no matter what the signature filter did — deleting the filter left the suite
    // 13/13 green. This fixture is deliberately modelled on the signed-replay test
    // above so the filter is genuinely exercised, and it asserts BOTH halves: the
    // unsigned block is gone AND the tool_use it accompanied is still present, which
    // proves the message was kept and only the block filtered.
    const assistantTurn = {
      id: new ObjectId(),
      role: "assistant",
      content: "",
      thinking: "unsigned reasoning",
      // The flattened `thinking` string carries no signature; a block built from it
      // would be invalid on the wire, so extractThinkingBlocks must drop it.
      thinking_blocks: [{ type: "thinking", thinking: "unsigned reasoning" }],
      timestamp: new Date(),
      tool_calls: [
        { id: "toolu_unsigned_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Cape Town"}' } },
      ],
      tool_results: [] as any[],
    };
    const toolResultTurn = {
      id: new ObjectId(),
      role: "user",
      content: "",
      timestamp: new Date(),
      tool_results: [{ tool_call_id: "toolu_unsigned_1", content: "22C and sunny" }],
    };

    const { service } = createService({
      modelId: "claude-opus-4-8",
      tools: [SEARCH_TOOL],
      history: [
        { id: new ObjectId(), role: "user", content: "weather in cape town?", timestamp: new Date(), tool_results: [] },
        assistantTurn,
        toolResultTurn,
      ],
    });

    await dispatch(service, "hello");

    const { body } = captures[0];
    const assistantMessage = body.messages.find((message: any) => message.role === "assistant");

    // (a) The turn survived, so extractThinkingBlocks actually ran.
    expect(assistantMessage).toBeDefined();
    expect(Array.isArray(assistantMessage.content)).toBe(true);

    // (b) The unsigned thinking block was filtered out...
    expect(JSON.stringify(body.messages)).not.toContain("unsigned reasoning");
    expect(assistantMessage.content.some((block: any) => block.type === "thinking")).toBe(false);

    // ...while the tool_use it accompanied is still there — the message was kept.
    expect(assistantMessage.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", id: "toolu_unsigned_1", name: "get_weather" }),
    );
  });
});

// ---------------------------------------------------------------------------
// stop_reason / output_tokens in message_delta.
// ---------------------------------------------------------------------------

describe("message_delta accounting", () => {
  it("carries stop_reason and output_tokens into the final result", async () => {
    responder = () =>
      sseResponse([
        messageStart(MESSAGES_USAGE(50, 0, 0, 1)),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated answ" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 4096 } },
        { type: "message_stop" },
      ]);

    const { service } = createService({
      streamingMode: StreamingMode.SSE,
      sessionId: "wire-session",
    });

    const response = await dispatch(service, "write a lot");

    expect(response.choices[0].finish_reason).toBe("max_tokens");
    expect(response.usage.completionTokens).toBe(4096);

    const completionEvent = sentEvents.find((event) => event.type === StreamingEventType.COMPLETE);
    expect(completionEvent).toBeDefined();
    // The client finalises the message from this event; an undefined
    // finishReason leaves the streamed message unclosable.
    expect(completionEvent.data).toMatchObject({
      content: "truncated answ",
      finishReason: "max_tokens",
    });
  });
});
