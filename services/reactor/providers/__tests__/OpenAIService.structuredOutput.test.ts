import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { ReactorProviderConfig } from "../../../../types/model.types";

// Mock the openai module so the constructor doesn't reach the network.
jest.unstable_mockModule("openai", () => ({
  __esModule: true,
  default: class OpenAI {
    chat = { completions: { create: jest.fn() } };
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

let OpenAIService: any;

beforeAll(async () => {
  const mod = await import("../OpenAIService");
  OpenAIService = mod.default;
});

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

/**
 * Build a service with just enough state for createPrompt(), and control whether
 * function-calling tools are available.
 */
function createService(opts?: { tools?: any[]; supportsFunctionCalling?: boolean }) {
  const svc: any = new OpenAIService({ apiKey: "test-key" }, mockContext);
  svc.chatState = {
    id: "session-1",
    personaId: "p1",
    modelId: "gpt-4o",
    history: [{ role: "system", content: "You are helpful." }],
    files: [],
  };
  svc.getToolsDefinitions = jest.fn(async () => opts?.tools ?? []);
  svc.modelSupportsFunctionCalling = jest.fn(
    async () => opts?.supportsFunctionCalling ?? false,
  );
  return svc;
}

const A_TOOL = {
  type: "function",
  function: { name: "get_weather", parameters: { type: "object", properties: {} } },
};

describe("OpenAIService.createPrompt — providerConfig / structured output", () => {
  beforeEach(() => jest.clearAllMocks());

  it("produces no response_format when providerConfig is absent", async () => {
    const svc = createService();
    const prompt = await svc.createPrompt("hello");
    expect(prompt.response_format).toBeUndefined();
    expect(prompt.model).toBe("gpt-4o");
    // the current user turn is appended
    expect(prompt.messages[prompt.messages.length - 1]).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("maps structuredOutput to response_format json_schema", async () => {
    const svc = createService();
    const providerConfig: ReactorProviderConfig = {
      structuredOutput: { schema: SCHEMA, name: "extraction" },
    };
    const prompt = await svc.createPrompt("extract", providerConfig);
    expect(prompt.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "extraction", strict: true, schema: SCHEMA },
    });
  });

  it("maps sampling and reasoning params", async () => {
    const svc = createService();
    const prompt = await svc.createPrompt("hi", {
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 400,
      reasoningEffort: "high",
    });
    expect(prompt).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 400,
      reasoning_effort: "high",
    });
  });

  it("attaches tools when function calling is supported and no structured output requested", async () => {
    const svc = createService({ tools: [A_TOOL], supportsFunctionCalling: true });
    const prompt = await svc.createPrompt("hi");
    expect(prompt.tools).toEqual([A_TOOL]);
    expect(prompt.tool_choice).toBe("auto");
    expect(prompt.parallel_tool_calls).toBe(true);
  });

  it("suppresses tools when structured output is requested (mutually exclusive)", async () => {
    const svc = createService({ tools: [A_TOOL], supportsFunctionCalling: true });
    const prompt = await svc.createPrompt("extract", {
      structuredOutput: { schema: SCHEMA },
    });
    expect("tools" in prompt).toBe(false);
    expect(prompt.response_format.type).toBe("json_schema");
  });

  it("keeps tools when structured output is paired with an explicit tool choice", async () => {
    const svc = createService({ tools: [A_TOOL], supportsFunctionCalling: true });
    const prompt = await svc.createPrompt("do it", {
      structuredOutput: { schema: SCHEMA },
      toolChoice: { name: "get_weather" },
    });
    expect(prompt.tools).toEqual([A_TOOL]);
    // explicit tool choice overrides the default "auto"
    expect(prompt.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });
});
