import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { StreamingMode } from "../../types/streaming.types";
import { ReactorProviderConfig } from "../../../../types/model.types";

// Capture the last payload passed to ollama.chat
const chatMock = jest.fn(async () => ({
  message: { role: "assistant", content: '{"answer":"42"}', tool_calls: [] },
  prompt_eval_count: 1,
  eval_count: 1,
}));

jest.unstable_mockModule("ollama", () => ({
  __esModule: true,
  Ollama: class Ollama {
    chat = chatMock;
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

let OllamaAIService: any;

beforeAll(async () => {
  const mod = await import("../OllamaAIService");
  OllamaAIService = mod.default;
});

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const A_TOOL = { type: "function", function: { name: "get_weather" } };

function createService(opts?: { tools?: any[] }) {
  const svc: any = new OllamaAIService({ apiKey: "x" }, mockContext);
  svc.ai = { chat: chatMock };
  svc.streamingMode = StreamingMode.NONE;
  svc.chatState = {
    id: "session-1",
    personaId: "p1",
    modelId: "llama3",
    history: [{ role: "system", content: "sys" }],
    persona: { config: {} },
  };
  svc.personaProvider = { getPersona: jest.fn(async () => ({ id: "p1", modelId: "llama3" })) };
  svc.buildMessages = jest.fn((m: string) => [
    { role: "system", content: "sys" },
    { role: "user", content: m },
  ]);
  svc.getToolDefinitions = jest.fn(async () => opts?.tools ?? []);
  svc.persistChatState = jest.fn(async () => {});
  return svc;
}

describe("OllamaAIService — providerConfig / structured output", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not set format when no structured output is requested", async () => {
    const svc = createService();
    await svc.chat({ personaId: "p1", chatSessionId: "session-1", message: "hi" });
    const payload = chatMock.mock.calls[0][0] as any;
    expect("format" in payload).toBe(false);
  });

  it("sets the top-level format to the schema for structured output", async () => {
    const svc = createService();
    const providerConfig: ReactorProviderConfig = {
      structuredOutput: { schema: SCHEMA },
    };
    await svc.chat({
      personaId: "p1",
      chatSessionId: "session-1",
      message: "extract",
      providerConfig,
    });
    const payload = chatMock.mock.calls[0][0] as any;
    expect(payload.format).toEqual(SCHEMA);
    expect(payload.stream).toBe(false);
  });

  it("maps sampling params into the options object", async () => {
    const svc = createService();
    await svc.chat({
      personaId: "p1",
      chatSessionId: "session-1",
      message: "hi",
      providerConfig: { temperature: 0.3, maxTokens: 128 },
    });
    const payload = chatMock.mock.calls[0][0] as any;
    expect(payload.options).toEqual({ temperature: 0.3, num_predict: 128 });
  });

  it("suppresses tools when structured output is requested", async () => {
    const svc = createService({ tools: [A_TOOL] });
    await svc.chat({
      personaId: "p1",
      chatSessionId: "session-1",
      message: "extract",
      providerConfig: { structuredOutput: { schema: SCHEMA } },
    });
    const payload = chatMock.mock.calls[0][0] as any;
    expect(payload.tools).toBeUndefined();
  });

  it("passes tools through when no structured output is requested", async () => {
    const svc = createService({ tools: [A_TOOL] });
    await svc.chat({ personaId: "p1", chatSessionId: "session-1", message: "hi" });
    const payload = chatMock.mock.calls[0][0] as any;
    expect(payload.tools).toEqual([A_TOOL]);
  });
});
