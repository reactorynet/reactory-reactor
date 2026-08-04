import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { ReactorProviderConfig } from "../../../../types/model.types";

// Capture the config passed to ai.chats.create
const createMock = jest.fn(() => ({}));

jest.unstable_mockModule("@google/genai", () => ({
  __esModule: true,
  default: class GoogleGenAI {
    chats = { create: createMock };
  },
  GoogleGenAI: class GoogleGenAI {
    chats = { create: createMock };
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  Type: {},
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

let GoogleAIService: any;

beforeAll(async () => {
  const mod = await import("../GoogleAIService");
  GoogleAIService = mod.default;
});

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const A_TOOL = { functionDeclarations: [{ name: "get_weather" }] };

function createService(opts?: { supportsFunctionCalling?: boolean }) {
  const svc: any = new GoogleAIService({ apiKey: "x" }, mockContext);
  svc.ai = { chats: { create: createMock } };
  svc.model = { name: "gemini-2.0-flash" };
  svc.chatState = {
    id: "session-1",
    personaId: "p1",
    user: null,
    files: [],
    history: [],
  };
  svc.isImageGenerationModel = jest.fn(async () => false);
  svc.modelSupportsFunctionCalling = jest.fn(
    async () => opts?.supportsFunctionCalling ?? true,
  );
  svc.getAITools = jest.fn(async () => [A_TOOL]);
  return svc;
}

const HISTORY = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "hi" },
] as any[];

function lastConfig() {
  return (createMock.mock.calls[createMock.mock.calls.length - 1][0] as any).config;
}

describe("GoogleAIService.createChatSession — providerConfig / structured output", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not set responseJsonSchema without structured output, and keeps tools", async () => {
    const svc = createService({ supportsFunctionCalling: true });
    await svc.createChatSession(HISTORY);
    const cfg = lastConfig();
    expect(cfg.responseJsonSchema).toBeUndefined();
    expect(cfg.tools).toEqual([A_TOOL]);
  });

  it("sets responseMimeType + responseJsonSchema and suppresses tools for structured output", async () => {
    const svc = createService({ supportsFunctionCalling: true });
    const providerConfig: ReactorProviderConfig = {
      structuredOutput: { schema: SCHEMA },
    };
    await svc.createChatSession(HISTORY, providerConfig);
    const cfg = lastConfig();
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema).toEqual(SCHEMA);
    expect(cfg.tools).toBeUndefined();
  });

  it("maps sampling params and overrides hardcoded defaults", async () => {
    const svc = createService({ supportsFunctionCalling: false });
    await svc.createChatSession(HISTORY, { temperature: 0.1, maxTokens: 256 });
    const cfg = lastConfig();
    expect(cfg.temperature).toBe(0.1); // overrides the hardcoded 0.7
    expect(cfg.maxOutputTokens).toBe(256);
  });

  it("filters out empty assistant messages and avoids empty text parts", async () => {
    const svc = createService({ supportsFunctionCalling: false });
    const historyWithEmptyAssistant = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" }, // Empty / terminated assistant turn
    ];
    await svc.createChatSession(historyWithEmptyAssistant as any);
    const historyArg = (createMock.mock.calls[createMock.mock.calls.length - 1][0] as any).history;
    // Trailing user message is popped so history ends cleanly with no empty model parts
    expect(historyArg.some((h: any) => h.parts.some((p: any) => p.text === ""))).toBe(false);
  });

  it("trims trailing user messages from history to maintain strict model->user role alternation", async () => {
    const svc = createService({ supportsFunctionCalling: false });
    const historyUnterminated = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Interrupted question" }, // Unanswered user turn
    ];
    await svc.createChatSession(historyUnterminated as any);
    const historyArg = (createMock.mock.calls[createMock.mock.calls.length - 1][0] as any).history;
    // Trailing user message should be trimmed so the history ends with model role
    if (historyArg.length > 0) {
      expect(historyArg[historyArg.length - 1].role).toBe("model");
    }
  });
});
