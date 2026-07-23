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
});
