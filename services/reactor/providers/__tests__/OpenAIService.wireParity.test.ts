import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { ObjectId } from "mongodb";
import { StreamingEventType, StreamingMode } from "../../types/streaming.types";
import { ToolApprovalMode } from "../../../../ai/openai/types/chat";
import OpenAIService from "../OpenAIService";

/**
 * Wire-level behavioural matrix for the OpenAI-family providers after the
 * openai 4.87.3 -> 7.56.0 upgrade (three majors).
 *
 * WHY THIS EXISTS
 * ---------------
 * The other provider suites mock `openai` wholesale, so they prove the module's
 * own translator logic but never touch the SDK. The upgrade's risk is precisely
 * the part those suites cannot see: what the SDK puts on the wire once the
 * service has built its payload. This suite runs the REAL openai@7 client and
 * replaces only the transport (`globalThis.fetch`), so every assertion below is
 * a statement about the request the installed SDK actually emitted.
 *
 * Covered per family — openai, xai, copilot, azure-openai and a local
 * OpenAI-compatible endpoint (the ollama branch of `initializeClient`):
 *   - base URL and auth header selection
 *   - text completion (non-streaming)
 *   - streaming text with `stream_options.include_usage` and usage accounting
 *   - the tool-call loop: `tools` / `tool_choice` / `parallel_tool_calls` and
 *     reassembly of a fragmented `tool_calls` delta
 *   - structured output (`response_format.json_schema`), incl. tool suppression
 *   - a reasoning model with no `max_tokens`
 *   - image generation (`images.generate` with `response_format`)
 *
 * `ClientOptions.defaultQuery` is the one Azure-specific lever: it is how the
 * api-version reaches the query string, and it is asserted explicitly.
 *
 * No credentials and no network are used. Nothing here asserts that a model
 * EXISTS — only that the call shape the service produces is the one the SDK
 * sends.
 */

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

const captures: Capture[] = [];
let responder: (capture: Capture) => Response | Promise<Response> = () => {
  throw new Error("no responder installed");
};
let restoreFetch: (() => void) | null = null;

const sentEvents: any[] = [];

const mockContext: any = {
  log: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  getService: (): void => undefined,
  user: { _id: new ObjectId(), id: new ObjectId().toString() },
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
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Replace the transport. `openai@7` captures `globalThis.fetch` when the client
 * is constructed (`client.js`: `this.fetch = options.fetch ?? getDefaultFetch()`),
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
        /* leave as string (e.g. multipart) */
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A real SSE body, so the SDK's own parser and stream iterator run. */
function sseResponse(chunks: any[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body as any, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completionResponse(text: string, toolCalls?: any[]): Response {
  return jsonResponse({
    id: "chatcmpl-wire",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "wire-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls ? null : text,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "macro.search",
    description: "Search the workspace",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
};

interface ServiceOptions {
  providerId: string;
  modelId: string;
  tools?: any[];
  streamingMode?: StreamingMode;
}

function createService(options: ServiceOptions) {
  const persona: any = {
    id: `persona-${options.providerId}`,
    name: "Wire parity",
    providerId: options.providerId,
    modelId: options.modelId,
    systemPrompt: "You are a test.",
    // Keep pacing tight so the suite is fast; values are the pacer's own knobs.
    config: { streamingPace: { targetIntervalMs: 1, minChunkSize: 1, flushTimeoutMs: 5 } },
  };

  const props: any = {
    apiKey: "wire-test-key",
    streamingMode: options.streamingMode ?? StreamingMode.NONE,
    $services: {},
  };

  const service: any = new OpenAIService(props, mockContext);
  service.personaProvider = { getPersona: async (): Promise<any> => persona };
  service.macroService = { listMacrosForPersona: async (): Promise<any[]> => [] };
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
    id: "wire-session",
    personaId: persona.id,
    modelId: options.modelId,
    persona,
    history: [
      { role: "system", content: "You are a test." },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "prior question" },
    ],
    tools: options.tools ?? [],
    toolApprovalMode: ToolApprovalMode.PROMPT,
  };

  return { service, persona };
}

/**
 * Runs the exact sequence `chat()` runs after `initialize()`: build the prompt
 * from chat state, then dispatch it through the real SDK.
 */
async function dispatch(
  service: any,
  message: string | any[],
  providerConfig?: any,
): Promise<any> {
  await service.initializeClient(service.chatState.persona);
  const prompt = await service.createPrompt(message, providerConfig);
  return service.getAIResponse(prompt);
}

/** One entry per provider family, matching `initializeClient`'s branches. */
const FAMILIES = [
  {
    providerId: "openai",
    modelId: "gpt-4o",
    reasoningModelId: "o1",
    imageModel: "dall-e-3",
    expectedBaseURL: "https://api.openai.com/v1",
    authHeader: "authorization",
    expectedAuth: "Bearer wire-test-key",
    registryModels: 12,
  },
  {
    providerId: "xai",
    modelId: "grok-4.20",
    reasoningModelId: "grok-4-1-fast-reasoning",
    imageModel: "grok-imagine-image",
    expectedBaseURL: "https://api.x.ai/v1",
    authHeader: "authorization",
    expectedAuth: "Bearer wire-test-key",
    registryModels: 14,
  },
  {
    providerId: "copilot",
    modelId: "gpt-4o",
    reasoningModelId: "gpt-5.4",
    imageModel: "dall-e-3",
    expectedBaseURL: "https://models.inference.ai.azure.com",
    authHeader: "authorization",
    expectedAuth: "Bearer wire-test-key",
    registryModels: 3,
  },
  {
    providerId: "azure-openai",
    modelId: "gpt-4o",
    reasoningModelId: "gpt-5.4",
    imageModel: "dall-e-3",
    // The azure branch appends `/openai` to the endpoint and carries the version
    // in `defaultQuery`.
    expectedBaseURL: "https://wire-azure.openai.azure.com/openai",
    // `initializeClient` builds a plain `OpenAI` client for every family, so
    // key auth goes out as a Bearer token. The `api-key` header is only emitted
    // by the SDK's `AzureOpenAI` subclass, which this module has never used —
    // the same construction exists on openai 4.87.3, so this is unchanged by
    // the upgrade (flagged separately in the run report).
    authHeader: "authorization",
    expectedAuth: "Bearer wire-test-key",
    registryModels: 5,
  },
  {
    providerId: "ollama",
    modelId: "llama3.2",
    reasoningModelId: "deepseek-r1",
    imageModel: "dall-e-3",
    expectedBaseURL: "http://localhost:11434/v1",
    authHeader: "authorization",
    expectedAuth: "Bearer wire-test-key",
    registryModels: 30,
  },
] as const;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  captures.length = 0;
  sentEvents.length = 0;
  process.env = {
    ...ORIGINAL_ENV,
    AZURE_OPENAI_ENDPOINT: "https://wire-azure.openai.azure.com",
    AZURE_OPENAI_API_VERSION: "2024-02-15-preview",
  };
  installFetchRecorder();
});

afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Every family gets the full matrix.
// ---------------------------------------------------------------------------

describe.each(FAMILIES)(
  "openai@7 wire parity — $providerId ($registryModels registry models)",
  (family) => {
    it("addresses the configured base URL with the family's auth header", async () => {
      responder = () => completionResponse("ok");
      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
      });

      await dispatch(service, "hello");

      expect(captures).toHaveLength(1);
      const [request] = captures;
      expect(request.method).toBe("POST");
      expect(request.url.startsWith(`${family.expectedBaseURL}/chat/completions`)).toBe(true);
      expect(request.headers[family.authHeader]).toBe(family.expectedAuth);
      expect(request.body.model).toBe(family.modelId);
      expect(request.body.messages).toEqual(
        expect.arrayContaining([{ role: "user", content: "hello" }]),
      );
    });

    it("returns the non-streaming completion unchanged", async () => {
      responder = () => completionResponse(`hello from ${family.providerId}`);
      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
      });

      const response = await dispatch(service, "hello");

      expect(response.choices[0].message.content).toBe(`hello from ${family.providerId}`);
      expect(captures[0].body.stream).toBeUndefined();
    });

    it("streams text and keeps stream_options.include_usage accounting", async () => {
      responder = () =>
        sseResponse([
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [{ index: 0, delta: { content: ", world" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 34,
              total_tokens: 1234,
              prompt_tokens_details: { cached_tokens: 1024 },
            },
          },
        ]);

      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
        streamingMode: StreamingMode.SSE,
      });

      const response = await dispatch(service, "hello");

      // The request half of the accounting contract.
      expect(captures[0].body.stream).toBe(true);
      expect(captures[0].body.stream_options).toEqual({ include_usage: true });

      // The response half: usage from the final chunk survives normalisation.
      expect(response.choices[0].message.content).toBe("Hello, world");
      expect(response.choices[0].finish_reason).toBe("stop");
      expect(response.usage.totalTokens).toBe(1234);
      expect(response.usage.promptTokens).toBe(1200);
      expect(response.usage.completionTokens).toBe(34);
      expect(response.usage.promptTokensDetails).toEqual({ cached_tokens: 1024 });

      // Token + completion events reached the transport.
      const types = sentEvents.map((event) => event.type);
      expect(types).toContain(StreamingEventType.COMPLETE);
    });

    it("reassembles a fragmented tool-call delta and sends tools/tool_choice/parallel_tool_calls", async () => {
      responder = () =>
        sseResponse([
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_wire_1",
                      type: "function",
                      function: { name: "macro.search", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"q":"reac' } }],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'tory"}' } }] },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-wire",
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: family.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ]);

      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
        tools: [SEARCH_TOOL],
        streamingMode: StreamingMode.SSE,
      });

      const response = await dispatch(service, "search for reactory");

      // Request: the tools go out, with the parallel/auto defaults preserved.
      expect(captures[0].body.tools).toEqual([SEARCH_TOOL]);
      expect(captures[0].body.tool_choice).toBe("auto");
      expect(captures[0].body.parallel_tool_calls).toBe(true);

      // Response: the fragmented arguments are stitched back together.
      const toolCall = response.choices[0].message.tool_calls[0];
      expect(toolCall.id).toBe("call_wire_1");
      expect(toolCall.type).toBe("function");
      expect(toolCall.function.name).toBe("macro.search");
      expect(JSON.parse(toolCall.function.arguments)).toEqual({ q: "reactory" });
      expect(response.choices[0].finish_reason).toBe("tool_calls");

      const toolCallEvents = sentEvents.filter(
        (event) => event.type === StreamingEventType.TOOL_CALL,
      );
      expect(toolCallEvents).toHaveLength(1);
    });

    it("sends structured output as response_format.json_schema and suppresses tools", async () => {
      responder = () =>
        completionResponse('{"answer":"42"}');

      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
        tools: [SEARCH_TOOL],
      });

      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      };

      await dispatch(service, "answer in json", {
        structuredOutput: { name: "answer", strict: true, schema },
      });

      expect(captures[0].body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "answer", strict: true, schema },
      });
      // Mutually exclusive with the tool loop.
      expect(captures[0].body.tools).toBeUndefined();
    });

    // N3: the old name claimed reasoning-model-specific behaviour ("omits max_tokens for a
    // reasoning model"), but OpenAIService has no reasoning branch — it simply does not set
    // max_tokens unless a budget is supplied. The assertion would have passed even if
    // `reasoningModelId` were ignored entirely, so it is renamed to state what it proves:
    // no token budget is injected by default, and a supplied budget is forwarded verbatim.
    // (Flagged as a follow-up, not fixed here: o1/o3 reject `max_tokens` in favour of
    // `max_completion_tokens`, so a budget on a reasoning model may fail server-side. That
    // is identical on 4.87.3 and 7.56.0, so it is not a regression from this upgrade.)
    it("injects no max_tokens by default, and forwards a supplied budget verbatim", async () => {
      responder = () => completionResponse("thinking");
      const { service } = createService({
        providerId: family.providerId,
        modelId: family.reasoningModelId,
      });

      await dispatch(service, "reason about it");
      expect(captures[0].body.model).toBe(family.reasoningModelId);
      expect("max_tokens" in captures[0].body).toBe(false);

      // Control: when a budget IS requested it is forwarded verbatim.
      responder = () => completionResponse("thinking");
      await dispatch(service, "reason about it", { maxTokens: 512 });
      expect(captures[1].body.max_tokens).toBe(512);
    });

    it("generates an image with response_format passed through", async () => {
      responder = () =>
        jsonResponse({ created: 1_700_000_000, data: [{ b64_json: "d2lyZS1pbWFnZQ==" }] });

      const { service } = createService({
        providerId: family.providerId,
        modelId: family.modelId,
      });
      await service.initializeClient(service.chatState.persona);

      const result = await service.generateImage({
        prompt: "a wire-level diagram",
        model: family.imageModel,
      });

      const [request] = captures;
      expect(request.url.startsWith(`${family.expectedBaseURL}/images/generations`)).toBe(true);
      expect(request.body.model).toBe(family.imageModel);
      expect(request.body.response_format).toBe("b64_json");
      expect(result.data[0].b64_json).toBe("d2lyZS1pbWFnZQ==");
    });
  },
);

// ---------------------------------------------------------------------------
// Azure api-version: the one lever that is Azure-only.
// ---------------------------------------------------------------------------

describe("openai@7 wire parity — azure-openai api-version", () => {
  it("carries ClientOptions.defaultQuery into the query string", async () => {
    responder = () => completionResponse("ok");
    const { service } = createService({
      providerId: "azure-openai",
      modelId: "gpt-4o",
    });

    await dispatch(service, "hello");

    const url = new URL(captures[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://wire-azure.openai.azure.com/openai/chat/completions",
    );
    expect(url.searchParams.get("api-version")).toBe("2024-02-15-preview");
  });

  it("honours AZURE_OPENAI_API_VERSION", async () => {
    process.env.AZURE_OPENAI_API_VERSION = "2025-04-01-preview";
    responder = () => completionResponse("ok");
    const { service } = createService({
      providerId: "azure-openai",
      modelId: "gpt-4o",
    });

    await dispatch(service, "hello");

    expect(new URL(captures[0].url).searchParams.get("api-version")).toBe("2025-04-01-preview");
  });
});

// ---------------------------------------------------------------------------
// normalizeCompletion — the code path this upgrade had to change.
// openai 7 types a tool call as a discriminated union (function | custom).
// ---------------------------------------------------------------------------

describe("normalizeCompletion and the tool-call union", () => {
  function completionWith(toolCalls: any[]): any {
    return {
      id: "chatcmpl-wire",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: "tool_calls",
        },
      ],
    };
  }

  it("maps function tool calls to the AIChatCompletion shape", () => {
    const { service } = createService({ providerId: "openai", modelId: "gpt-4o" });

    const normalized = service.normalizeCompletion(
      completionWith([
        {
          id: "call_fn",
          type: "function",
          function: { name: "macro.search", arguments: '{"q":"x"}' },
        },
      ]),
    );

    expect(normalized.choices[0].message.tool_calls).toEqual([
      {
        id: "call_fn",
        type: "function",
        function: { name: "macro.search", arguments: '{"q":"x"}' },
      },
    ]);
  });

  it("keeps ids 1:1 when a custom tool call is present (no throw, no drop)", () => {
    const { service } = createService({ providerId: "openai", modelId: "gpt-4o" });

    const normalized = service.normalizeCompletion(
      completionWith([
        {
          id: "call_fn",
          type: "function",
          function: { name: "macro.search", arguments: '{"q":"x"}' },
        },
        // A `custom` (freeform grammar) tool call: the reactor never sends
        // custom tools, so this cannot occur in practice, but the union makes it
        // representable and the normaliser must stay total.
        { id: "call_custom", type: "custom", custom: { name: "freeform", input: "x" } },
      ]),
    );

    const toolCalls = normalized.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].id).toBe("call_fn");
    expect(toolCalls[0].function.name).toBe("macro.search");
    expect(toolCalls[1].id).toBe("call_custom");
    expect(toolCalls[1].function).toEqual({ name: "", arguments: "" });
  });
});
