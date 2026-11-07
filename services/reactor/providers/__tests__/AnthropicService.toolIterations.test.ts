import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: class Anthropic {
    messages = { create: jest.fn() };
  },
}));

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

let AnthropicService: any;
let DEFAULT_MAX_TOOL_ITERATIONS: number;
let TOOL_LOOP_TRUNCATED_FINISH_REASON: string;

beforeAll(async () => {
  const mod = await import("../AnthropicService");
  AnthropicService = mod.default;
  const limits = await import("../../toolIterations");
  DEFAULT_MAX_TOOL_ITERATIONS = limits.DEFAULT_MAX_TOOL_ITERATIONS;
  TOOL_LOOP_TRUNCATED_FINISH_REASON = limits.TOOL_LOOP_TRUNCATED_FINISH_REASON;
});

const persona: any = { id: "p1", tools: [], modelConfig: {} };

function createService() {
  const svc: any = new AnthropicService({ apiKey: "x" }, mockContext);
  svc.modelId = "claude-sonnet-4-5-20250929";
  svc.streamingMode = "NONE";
  svc.convertToolsToAnthropicFormat = jest.fn(() => undefined);
  // Stub capability resolvers so tests don't depend on providers.yaml.
  svc.getThinkingSupport = jest.fn(() => ({ mode: "budget" }));
  svc.getSamplingSupport = jest.fn(() => ({ temperature: true, topP: true, topK: true }));
  svc.createSystemPrompt = jest.fn(() => ({ content: "system" }));
  svc.executeToolCall = jest.fn(async () => ({
    type: "tool_result",
    tool_use_id: "x",
    content: "ok",
  }));
  // Nothing loaded from a conversation unless a test says otherwise.
  svc.chatState = {};
  svc.chatStateModel = null;
  return svc;
}

/**
 * A model that never stops asking for tools: every round-trip returns a
 * `tool_use` block, so the loop can only end by exhausting its budget.
 */
function alwaysRequestsTools(svc: any) {
  let call = 0;
  const create = jest.fn(async () => {
    call += 1;
    return {
      content: [{ type: "tool_use", id: `tool-${call}`, name: "get_weather", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  svc.anthropic = { messages: { create } };
  return create;
}

/**
 * The provider's tool loop must run under the REQUESTED budget.
 *
 * FALSIFICATION: these assertions are written so they fail if a provider-side
 * constant (the old `MAX_TOOL_ITERATIONS = 25`) is restored. A suite that only
 * exercised a model which stops on its own would pass with any hardcoded cap and
 * prove nothing — that is why every test here uses a model that never stops.
 */
describe("AnthropicService — tool loop iteration budget", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REACTOR_MAX_TOOL_ITERATIONS;
  });

  it("stops at the conversation's requested limit instead of a provider constant", async () => {
    // The only budget source is the conversation the provider loaded — the value
    // `setChatMaxToolIterations` writes and `AIProviderBase.loadChatState` copies
    // onto `ChatState`. A hardcoded 25 fails this assertion.
    const svc = createService();
    svc.chatState = { maxToolIterations: 3 };
    const create = alwaysRequestsTools(svc);

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.iterations).toBe(3);
    expect(result.maxToolIterations).toBe(3);
    expect(result.finishReason).toBe(TOOL_LOOP_TRUNCATED_FINISH_REASON);
    expect(svc.executeToolCall).toHaveBeenCalledTimes(3);
  });

  it("names the effective limit in the exhaustion warning, not a constant", async () => {
    const svc = createService();
    svc.chatState = { maxToolIterations: 3 };
    alwaysRequestsTools(svc);

    await svc.runToolLoop([], persona, "session-1", "msg-1");

    expect(mockContext.warn).toHaveBeenCalledWith(
      expect.stringContaining("exceeded 3 iterations"),
      expect.objectContaining({ maxToolIterations: 3, iterations: 3 }),
      "AnthropicService.runToolLoop",
    );
  });

  it("honours the conversation's maxToolIterations when no per-call value is passed", async () => {
    const svc = createService();
    svc.chatState = { maxToolIterations: 4 };
    const create = alwaysRequestsTools(svc);

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    expect(create).toHaveBeenCalledTimes(4);
    expect(result.maxToolIterations).toBe(4);
  });

  it("falls back to the loaded conversation document when the snapshot carries no budget", async () => {
    const svc = createService();
    svc.chatState = {};
    svc.chatStateModel = { maxToolIterations: 5 };
    const create = alwaysRequestsTools(svc);

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    // The snapshot has no value, so the loaded conversation document supplies it.
    expect(result.maxToolIterations).toBe(5);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("does not clamp a deliberately small budget upward", async () => {
    const svc = createService();
    svc.chatState = { maxToolIterations: 1 };
    const create = alwaysRequestsTools(svc);

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(1);
  });

  it("falls back to the documented platform default when nothing requests a budget", async () => {
    const svc = createService();
    const create = alwaysRequestsTools(svc);

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    // 200 is the platform default. A hardcoded 25 fails this assertion.
    expect(DEFAULT_MAX_TOOL_ITERATIONS).toBe(200);
    expect(result.maxToolIterations).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
    expect(create).toHaveBeenCalledTimes(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("does not stop early when the model finishes within budget", async () => {
    const svc = createService();
    svc.chatState = { maxToolIterations: 10 };
    let call = 0;
    svc.anthropic = {
      messages: {
        create: jest.fn(async () => {
          call += 1;
          if (call === 1) {
            return {
              content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          return {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }),
      },
    };

    const result = await svc.runToolLoop([], persona, "session-1", "msg-1");

    expect(result.finishReason).toBe("end_turn");
    expect(result.content).toBe("done");
    expect(result.iterations).toBe(2);
    expect(result.maxToolIterations).toBe(10);
  });
});

describe("AnthropicService — truncation visibility", () => {
  beforeEach(() => jest.clearAllMocks());

  it("marks a capped completion as truncated so it cannot be mistaken for a finished turn", () => {
    const svc = createService();

    const completion = svc.buildToolLoopCompletion(
      {
        content: "I've reached the maximum number of tool iterations (3).",
        finishReason: TOOL_LOOP_TRUNCATED_FINISH_REASON,
        toolCalls: [],
        iterations: 3,
        maxToolIterations: 3,
      },
      undefined,
    );

    expect(completion.choices[0].finish_reason).toBe(TOOL_LOOP_TRUNCATED_FINISH_REASON);
    expect(completion.toolIterationLimitReached).toBe(true);
    expect(completion.iterationsCompleted).toBe(3);
    expect(completion.maxToolIterations).toBe(3);
    // Both shapes a consumer may read are flagged.
    expect(completion.choices[0].message.toolIterationLimitReached).toBe(true);
    expect(completion.choices[0].message.maxToolIterations).toBe(3);
  });

  it("leaves a normal completion unflagged", () => {
    const svc = createService();

    const completion = svc.buildToolLoopCompletion(
      {
        content: "done",
        finishReason: "end_turn",
        toolCalls: [],
        iterations: 2,
        maxToolIterations: 200,
      },
      undefined,
    );

    expect(completion.choices[0].finish_reason).toBe("end_turn");
    expect(completion.toolIterationLimitReached).toBeUndefined();
    expect(completion.choices[0].message.toolIterationLimitReached).toBeUndefined();
  });
});
