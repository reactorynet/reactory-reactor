import { describe, it, expect, beforeEach, jest, afterEach } from "@jest/globals";
import { ObjectId } from "mongodb";
import {
  StreamingMode,
  StreamingEventType,
  CompletionStreamingEvent,
  ErrorStreamingEvent,
  TokenStreamingEvent,
  ToolCallStreamingEvent,
} from "../../types/streaming.types";
import { ToolApprovalMode } from "../../../../ai/openai/types/chat";
import { StreamingEventFactory } from "../../streaming/StreamingEventFactory";

// ---------------------------------------------------------------------------
// Helpers – we test OpenAIService methods by instantiating the class with
// minimal mocks.  Because the class relies on decorators resolved at runtime
// we need to supply a lightweight mock context / props.
// ---------------------------------------------------------------------------

// Capture sent events so we can assert on them
const sentEvents: any[] = [];

const mockTransportManager = {
  sendEventToSession: jest.fn(async (_sid: string, event: any) => {
    sentEvents.push(event);
  }),
};

const mockSessionManager = {
  getSession: jest.fn(),
  createSession: jest.fn(),
};

const mockContext: any = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  getService: jest.fn(),
  user: { _id: new ObjectId(), id: new ObjectId().toString() },
  partner: { _id: new ObjectId() },
};

const mockPersonaProvider: any = {
  getPersona: jest.fn().mockReturnValue({
    id: "test-persona",
    name: "Test",
    providerId: "openai",
    modelId: "gpt-4",
    systemPrompt: "You are a helpful assistant.",
    config: {},
  }),
};

const mockMacroService: any = {
  listMacrosForPersona: jest.fn().mockResolvedValue([]),
};

// We import the class after mocking OpenAI so the constructor doesn't fail.
// The mock returns a minimal object; individual tests override `create` as needed.
jest.unstable_mockModule("openai", () => ({
  __esModule: true,
  default: class OpenAI {
    chat = {
      completions: {
        create: jest.fn(),
      },
    };
  },
}));

// Dynamically import the service after mocking
let OpenAIService: any;

beforeAll(async () => {
  const mod = await import("../OpenAIService");
  OpenAIService = mod.default;
});

/**
 * Helper to create an OpenAIService instance with mocks wired up.
 */
function createService(overrides?: { toolApprovalMode?: ToolApprovalMode }) {
  const props: any = {
    apiKey: "test-key",
    streamingMode: StreamingMode.SSE,
    $services: {},
  };

  const svc = new OpenAIService(props, mockContext);
  svc.personaProvider = mockPersonaProvider;
  svc.macroService = mockMacroService;
  svc.streamingTransportManager = mockTransportManager;
  svc.streamingSessionManager = mockSessionManager;
  svc.streamingMode = StreamingMode.SSE;

  // Minimal chatState to avoid null-ref
  svc.chatState = {
    id: "test-session-id",
    personaId: "test-persona",
    modelId: "gpt-4",
    history: [],
    toolApprovalMode: overrides?.toolApprovalMode ?? ToolApprovalMode.PROMPT,
  };

  return svc;
}

// ---------------------------------------------------------------------------
// Async iterable helper to simulate an OpenAI streaming response
// ---------------------------------------------------------------------------
function createMockStream(chunks: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next() {
          if (idx < chunks.length) {
            return { value: chunks[idx++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

describe("OpenAIService – streaming event shapes", () => {
  let svc: any;

  beforeEach(() => {
    sentEvents.length = 0;
    jest.clearAllMocks();
    svc = createService();
  });

  // -----------------------------------------------------------------------
  // Unit tests for event factory methods
  // -----------------------------------------------------------------------

  // Event construction moved out of the provider into StreamingEventFactory —
  // OpenAIService now calls the factory's statics, so these shapes are asserted
  // against their actual owner. Calling them as `svc.createXEvent(...)` failed
  // with "svc.createCompletionEvent is not a function".

  describe("StreamingEventFactory.createCompletionEvent", () => {
    it("should produce data with top-level finishReason (not nested in metadata)", () => {
      const event: CompletionStreamingEvent = StreamingEventFactory.createCompletionEvent(
        "Hello world",
        "stop",
        undefined,
        { sessionId: "session-1" },
      );

      expect(event.type).toBe(StreamingEventType.COMPLETE);
      // Client expects data.finishReason at the top level
      expect(event.data.content).toBe("Hello world");
      expect(event.data.finishReason).toBe("stop");
      // Token counts and model name are deliberately not carried on the event.
      expect((event.data as any).metadata).toBeUndefined();
    });

    it("should carry thinking when supplied", () => {
      const event: CompletionStreamingEvent = StreamingEventFactory.createCompletionEvent(
        "response",
        "stop",
        "chain of thought",
        { sessionId: "session-1" },
      );

      expect(event.data.thinking).toBe("chain of thought");
      expect(event.data.finishReason).toBe("stop");
    });

    it("should omit thinking entirely when not supplied", () => {
      const event = StreamingEventFactory.createCompletionEvent("response", "stop");
      expect("thinking" in (event.data as any)).toBe(false);
    });

    it("should default finishReason to stop", () => {
      const event = StreamingEventFactory.createCompletionEvent("response");
      expect(event.data.finishReason).toBe("stop");
    });
  });

  describe("StreamingEventFactory.createErrorEvent", () => {
    it("should produce data with code and message fields", () => {
      const event: ErrorStreamingEvent = StreamingEventFactory.createErrorEvent(
        "STREAM_ERROR",
        "Connection lost",
        { detail: "timeout" },
        { sessionId: "session-1" },
      );

      expect(event.type).toBe(StreamingEventType.ERROR);
      expect(event.data.code).toBe("STREAM_ERROR");
      expect(event.data.message).toBe("Connection lost");
      expect(event.data.details).toEqual({ detail: "timeout" });
    });
  });

  describe("StreamingEventFactory.createTokenEvent", () => {
    it("should produce correct token data shape", () => {
      const event: TokenStreamingEvent = StreamingEventFactory.createTokenEvent(
        "Hello",
        0,
        { sessionId: "session-1" },
      );

      expect(event.type).toBe(StreamingEventType.TOKEN);
      // `content` mirrors `delta` for a token event: each event carries only the
      // newly produced text, and the client accumulates.
      expect(event.data).toEqual({
        content: "Hello",
        delta: "Hello",
        position: 0,
        isComplete: false,
      });
    });
  });

  describe("StreamingEventFactory.createToolCallEvent", () => {
    it("should produce correct tool call data shape", () => {
      const event: ToolCallStreamingEvent = StreamingEventFactory.createToolCallEvent(
        "call_123",
        "searchWeb",
        '{"query":"test"}',
        true,
        undefined,
        { sessionId: "session-1" },
      );

      expect(event.type).toBe(StreamingEventType.TOOL_CALL);
      expect(event.data.id).toBe("call_123");
      expect(event.data.name).toBe("searchWeb");
      expect(event.data.arguments).toBe('{"query":"test"}');
      expect(event.data.isComplete).toBe(true);
    });

    it("should generate an ObjectId when id is empty", () => {
      const event: ToolCallStreamingEvent = StreamingEventFactory.createToolCallEvent(
        "",
        "readFile",
        "{}",
        false,
        undefined,
        { sessionId: "session-1" },
      );

      expect(event.data.id).toBeTruthy();
      expect(ObjectId.isValid(event.data.id)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Integration tests for handleStreamingRequest
  // -----------------------------------------------------------------------

  describe("handleStreamingRequest", () => {
    it("should accumulate text tokens and send completion event", async () => {
      const chunks = [
        { id: "chatcmpl-1", model: "gpt-4", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
        { id: "chatcmpl-1", model: "gpt-4", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
        { id: "chatcmpl-1", model: "gpt-4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];

      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue(createMockStream(chunks)),
          },
        },
      };

      const prompt: any = { model: "gpt-4", messages: [{ role: "user", content: "Hi" }] };
      const result = await svc.handleStreamingRequest({
        sessionId: "test-session-id",
        prompt,
        messageId: "msg-1",
      });

      // The returned ChatCompletion should have accumulated text
      expect(result.choices[0].message.content).toBe("Hello world");
      expect(result.choices[0].finish_reason).toBe("stop");

      // Should have sent at least one token event and one completion event
      const tokenEvents = sentEvents.filter((e) => e.type === StreamingEventType.TOKEN);
      const completionEvents = sentEvents.filter((e) => e.type === StreamingEventType.COMPLETE);

      expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
      expect(completionEvents.length).toBe(1);

      // Verify completion event shape matches client expectations
      const completion = completionEvents[0];
      expect(completion.data.content).toBe("Hello world");
      expect(completion.data.finishReason).toBe("stop");
      expect((completion.data as any).metadata).toBeUndefined();
    });

    it("should accumulate reasoning tokens and include in completion", async () => {
      const chunks = [
        { id: "chatcmpl-1", model: "o1-preview", choices: [{ index: 0, delta: { reasoning_content: "Let me think" }, finish_reason: null }] },
        { id: "chatcmpl-1", model: "o1-preview", choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: null }] },
        { id: "chatcmpl-1", model: "o1-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];

      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue(createMockStream(chunks)),
          },
        },
      };

      const prompt: any = { model: "o1-preview", messages: [{ role: "user", content: "Think" }] };
      await svc.handleStreamingRequest({
        sessionId: "test-session-id",
        prompt,
        messageId: "msg-1",
      });

      const completionEvents = sentEvents.filter((e) => e.type === StreamingEventType.COMPLETE);
      expect(completionEvents.length).toBe(1);
      expect(completionEvents[0].data.thinking).toBe("Let me think");
      expect(completionEvents[0].data.content).toBe("Answer");
    });

    it("should accumulate tool calls and emit tool_call events in PROMPT mode", async () => {
      const chunks = [
        {
          id: "chatcmpl-2",
          model: "gpt-4",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: "call_abc",
                type: "function",
                function: { name: "searchWeb", arguments: '{"q' },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-2",
          model: "gpt-4",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: 'uery":"test"}' },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-2",
          model: "gpt-4",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];

      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue(createMockStream(chunks)),
          },
        },
      };

      const prompt: any = { model: "gpt-4", messages: [{ role: "user", content: "Search" }] };
      const result = await svc.handleStreamingRequest({
        sessionId: "test-session-id",
        prompt,
        messageId: "msg-2",
      });

      // Verify the reconstructed result has tool calls
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls[0].id).toBe("call_abc");
      expect(result.choices[0].message.tool_calls[0].function.name).toBe("searchWeb");
      expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"query":"test"}');

      // In PROMPT mode, tool_call events should be sent
      const toolCallEvents = sentEvents.filter((e) => e.type === StreamingEventType.TOOL_CALL);
      expect(toolCallEvents.length).toBe(1);
      expect(toolCallEvents[0].data.id).toBe("call_abc");
      expect(toolCallEvents[0].data.name).toBe("searchWeb");
    });

    it("should suppress tool_call and completion events in AUTO mode", async () => {
      svc = createService({ toolApprovalMode: ToolApprovalMode.AUTO });

      const chunks = [
        {
          id: "chatcmpl-3",
          model: "gpt-4",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: "call_auto",
                type: "function",
                function: { name: "readFile", arguments: '{"path":"/tmp"}' },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-3",
          model: "gpt-4",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];

      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue(createMockStream(chunks)),
          },
        },
      };

      const prompt: any = { model: "gpt-4", messages: [{ role: "user", content: "Read" }] };
      await svc.handleStreamingRequest({
        sessionId: "test-session-id",
        prompt,
        messageId: "msg-3",
      });

      const toolCallEvents = sentEvents.filter((e) => e.type === StreamingEventType.TOOL_CALL);
      const completionEvents = sentEvents.filter((e) => e.type === StreamingEventType.COMPLETE);

      expect(toolCallEvents.length).toBe(0);
      expect(completionEvents.length).toBe(0);
    });

    it("should send error event and throw on stream failure", async () => {
      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue(
              (async function* () {
                yield { id: "x", model: "gpt-4", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] };
                throw new Error("Network timeout");
              })(),
            ),
          },
        },
      };

      const prompt: any = { model: "gpt-4", messages: [{ role: "user", content: "Hi" }] };

      await expect(
        svc.handleStreamingRequest({ sessionId: "test-session-id", prompt, messageId: "msg-4" }),
      ).rejects.toThrow("AI provider stream interrupted");

      const errorEvents = sentEvents.filter((e) => e.type === StreamingEventType.ERROR);
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].data.code).toBeDefined();
      expect(errorEvents[0].data.message).toBeDefined();
    });

    it("should send error event on connection failure", async () => {
      svc.ai = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(
              Object.assign(new Error("Unauthorized"), { code: "AUTH_ERROR" }),
            ),
          },
        },
      };

      const prompt: any = { model: "gpt-4", messages: [{ role: "user", content: "Hi" }] };

      await expect(
        svc.handleStreamingRequest({ sessionId: "test-session-id", prompt, messageId: "msg-5" }),
      ).rejects.toThrow("Failed to connect to AI provider");

      const errorEvents = sentEvents.filter((e) => e.type === StreamingEventType.ERROR);
      expect(errorEvents.length).toBe(1);
      // Verify error event has code in data.code (not swapped with message)
      expect(errorEvents[0].data.code).toBeDefined();
      expect(errorEvents[0].data.message).toBeDefined();
    });
  });
});
