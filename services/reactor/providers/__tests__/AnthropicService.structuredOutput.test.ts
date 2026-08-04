import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { ReactorProviderConfig } from "../../../../types/model.types";

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

beforeAll(async () => {
  const mod = await import("../AnthropicService");
  AnthropicService = mod.default;
});

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function createService(opts?: {
  personaTools?: any[];
  modelId?: string;
  thinking?: { mode: "adaptive" | "budget" | "none"; effort?: string; display?: string };
  sampling?: { temperature: boolean; topP: boolean; topK: boolean };
}) {
  const svc: any = new AnthropicService({ apiKey: "x" }, mockContext);
  svc.modelId = opts?.modelId ?? "claude-sonnet-4-5-20250929";
  svc.streamingMode = "NONE";
  svc.convertToolsToAnthropicFormat = jest.fn(
    () => opts?.personaTools,
  );
  // Stub capability resolvers so tests don't depend on providers.yaml.
  svc.getThinkingSupport = jest.fn(() => opts?.thinking ?? { mode: "budget" });
  svc.getSamplingSupport = jest.fn(
    () => opts?.sampling ?? { temperature: true, topP: true, topK: true },
  );
  svc.createSystemPrompt = jest.fn(() => ({ content: "system" }));
  svc.executeToolCall = jest.fn(async () => ({
    type: "tool_result",
    tool_use_id: "x",
    content: "should-not-run",
  }));
  return svc;
}

const persona: any = { id: "p1", tools: [], modelConfig: {} };

describe("AnthropicService — providerConfig / structured output", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("buildRequestParams", () => {
    it("injects a forced schema tool + tool_choice and suppresses persona tools", () => {
      const svc = createService({
        personaTools: [{ name: "get_weather", input_schema: {} }],
        thinking: { mode: "adaptive", effort: "high", display: "summarized" },
      });
      const providerConfig: ReactorProviderConfig = {
        structuredOutput: { schema: SCHEMA, name: "extraction" },
      };
      const params = svc.buildRequestParams([], persona, { providerConfig });

      expect(params.tools).toEqual([
        { name: "extraction", description: expect.any(String), input_schema: SCHEMA },
      ]);
      expect(params.tool_choice).toEqual({ type: "tool", name: "extraction" });
      // thinking is disabled for structured output
      expect(params.thinking).toBeUndefined();
      expect((params as any).output_config).toBeUndefined();
    });

    it("applies caller sampling and disables thinking", () => {
      const svc = createService({
        thinking: { mode: "budget" },
        sampling: { temperature: true, topP: true, topK: true },
      });
      const params = svc.buildRequestParams([], persona, {
        providerConfig: { temperature: 0.2, maxTokens: 500 },
      });
      expect(params.thinking).toBeUndefined();
      expect(params.temperature).toBe(0.2);
      expect(params.max_tokens).toBe(500);
    });

    it("keeps legacy budget thinking when no augmented config is supplied", () => {
      const svc = createService({ thinking: { mode: "budget" } });
      const params = svc.buildRequestParams([], persona, {});
      expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    });

    it("uses adaptive thinking + effort and never budget_tokens for adaptive models", () => {
      const svc = createService({
        modelId: "claude-opus-4-8",
        thinking: { mode: "adaptive", effort: "high", display: "summarized" },
        sampling: { temperature: false, topP: false, topK: false },
      });
      const params = svc.buildRequestParams([], persona, {});
      expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect((params as any).thinking.budget_tokens).toBeUndefined();
      expect((params as any).output_config).toEqual({ effort: "high" });
      expect(params.temperature).toBeUndefined();
    });

    it("strips caller temperature on adaptive models that reject it and keeps thinking", () => {
      const svc = createService({
        modelId: "claude-opus-4-8",
        thinking: { mode: "adaptive", effort: "high", display: "summarized" },
        sampling: { temperature: false, topP: false, topK: false },
      });
      const params = svc.buildRequestParams([], persona, {
        providerConfig: { temperature: 0.5 },
      });
      // unsupported sampling stripped; adaptive thinking preserved
      expect(params.temperature).toBeUndefined();
      expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    });
  });

  describe("runToolLoop structured-output bypass", () => {
    it("returns the schema tool input as JSON content without executing it", async () => {
      const svc = createService();
      const structuredResult = { answer: "42" };
      svc.anthropic = {
        messages: {
          create: jest.fn(async () => ({
            content: [
              { type: "tool_use", id: "t1", name: "response", input: structuredResult },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          })),
        },
      };

      const result = await svc.runToolLoop([], persona, "session-1", "msg-1", {
        structuredOutput: { schema: SCHEMA },
      });

      expect(result.content).toBe(JSON.stringify(structuredResult));
      expect(result.finishReason).toBe("end_turn");
      // the schema tool must NOT be executed as a macro
      expect(svc.executeToolCall).not.toHaveBeenCalled();
      // the model was only called once (no continuation)
      expect(svc.anthropic.messages.create).toHaveBeenCalledTimes(1);
    });

    it("still executes real tools when there is no structured output", async () => {
      const svc = createService();
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
      expect(svc.executeToolCall).toHaveBeenCalledTimes(1);
      expect(result.content).toBe("done");
    });
  });
  describe("translateContentBlocks", () => {
    it("translates OpenAI-style image_url content blocks to Anthropic-compatible image content blocks", () => {
      const svc = createService();
      
      const input = [
        { type: "text", text: "Here is an image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA" } }
      ];
      
      const output = svc.translateContentBlocks(input);
      
      expect(output).toEqual([
        { type: "text", text: "Here is an image" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAA"
          }
        }
      ]);
    });

    it("leaves regular text messages unchanged", () => {
      const svc = createService();
      const input = "Hello, world!";
      const output = svc.translateContentBlocks(input);
      expect(output).toBe(input);
    });
  });

  describe("sanitizeToolCallsAndResults", () => {
    it("preserves paired tool_use and tool_result blocks", () => {
      const svc = createService();
      
      const input = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "t1", name: "get_weather", input: {} }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "sunny" }
          ]
        }
      ];

      const output = svc.sanitizeToolCallsAndResults(input);
      expect(output).toEqual(input);
    });

    it("strips uncompleted tool_use blocks", () => {
      const svc = createService();
      
      const input = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "t1", name: "get_weather", input: {} }
          ]
        },
        { role: "user", content: "Wait, do something else instead" } // No tool_result!
      ];

      const output = svc.sanitizeToolCallsAndResults(input);
      expect(output).toEqual([
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" }
          ]
        },
        { role: "user", content: "Wait, do something else instead" }
      ]);
    });

    it("removes empty assistant messages if all tool_uses are stripped and no text is left", () => {
      const svc = createService();
      
      const input = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "get_weather", input: {} }
          ]
        },
        { role: "user", content: "Wait, do something else instead" }
      ];

      const output = svc.sanitizeToolCallsAndResults(input);
      expect(output).toEqual([
        { role: "user", content: "Hello" },
        { role: "user", content: "Wait, do something else instead" }
      ]);
    });
  });

  describe("thinking block replay", () => {
    // Anthropic rejects a tool-result turn whose assistant message dropped the
    // thinking blocks that produced the tool_use ("Expected `thinking` or
    // `redacted_thinking`, but found ..."), so they must survive the round trip
    // through the persisted history.
    const historyWithThinking = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "Let me check",
        thinking: "I should call the weather tool",
        thinking_blocks: [
          { type: "thinking", thinking: "I should call the weather tool", signature: "sig-abc" },
        ],
        tool_calls: [
          { id: "t1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "sunny" },
    ];

    it("replays stored thinking blocks first on the assistant turn carrying the tool_use", () => {
      const svc = createService();
      const messages = svc.convertHistoryToAnthropicFormat(historyWithThinking);

      const assistant = messages.find((m: any) => m.role === "assistant");
      expect(assistant.content[0]).toEqual({
        type: "thinking",
        thinking: "I should call the weather tool",
        signature: "sig-abc",
      });
      expect(assistant.content[1]).toEqual({ type: "text", text: "Let me check" });
      expect(assistant.content[2]).toMatchObject({ type: "tool_use", id: "t1", name: "get_weather" });
    });

    it("drops unsigned thinking blocks, which the API would reject", () => {
      const svc = createService();
      const messages = svc.convertHistoryToAnthropicFormat([
        ...historyWithThinking.slice(0, 1),
        {
          ...historyWithThinking[1],
          thinking_blocks: [{ type: "thinking", thinking: "no signature here" }],
        },
        historyWithThinking[2],
      ]);

      const assistant = messages.find((m: any) => m.role === "assistant");
      expect(assistant.content.some((b: any) => b.type === "thinking")).toBe(false);
    });

    it("keeps replayed thinking blocks when the request enables thinking", () => {
      const svc = createService({
        modelId: "claude-opus-4-8",
        thinking: { mode: "adaptive", effort: "high", display: "summarized" },
        sampling: { temperature: false, topP: false, topK: false },
      });
      const messages = svc.convertHistoryToAnthropicFormat(historyWithThinking);
      const params = svc.buildRequestParams(messages, persona, {});

      const assistant = params.messages.find((m: any) => m.role === "assistant");
      expect(assistant.content[0].type).toBe("thinking");
    });

    it("strips replayed thinking blocks when thinking is off for the request", () => {
      const svc = createService({
        modelId: "claude-opus-4-8",
        thinking: { mode: "adaptive", effort: "high", display: "summarized" },
        sampling: { temperature: false, topP: false, topK: false },
      });
      const messages = svc.convertHistoryToAnthropicFormat(historyWithThinking);
      // Structured output forces tool_choice, which disables thinking — sending
      // thinking blocks alongside disabled thinking is itself a 400.
      const params = svc.buildRequestParams(messages, persona, {
        providerConfig: { structuredOutput: { schema: SCHEMA, name: "extraction" } },
      });

      expect(params.thinking).toBeUndefined();
      const assistant = params.messages.find((m: any) => m.role === "assistant");
      expect(assistant.content.some((b: any) => b.type === "thinking")).toBe(false);
      // The rest of the turn survives the strip.
      expect(assistant.content.some((b: any) => b.type === "tool_use")).toBe(true);
    });
  });

});
