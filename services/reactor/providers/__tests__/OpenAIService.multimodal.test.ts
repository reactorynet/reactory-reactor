import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import { ObjectId } from "mongodb";

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

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const MULTIMODAL = [{ type: "text", text: "look at this screenshot" }, IMAGE_PART];

function createService(history: any[] = [{ role: "system", content: "You are helpful." }]) {
  const svc: any = new OpenAIService({ apiKey: "test-key" }, mockContext);
  svc.chatState = {
    id: "session-1",
    personaId: "p1",
    modelId: "gpt-4o",
    history,
    files: [],
  };
  svc.getToolsDefinitions = jest.fn(async () => []);
  svc.modelSupportsFunctionCalling = jest.fn(async () => false);
  svc.ai = {
    chat: {
      completions: {
        create: jest.fn(async () => ({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })),
      },
    },
  };
  return svc;
}

describe("OpenAIService — multimodal (vision) turns", () => {
  it("keeps image content parts when building the prompt", async () => {
    const svc = createService();
    const prompt: any = await svc.createPrompt(MULTIMODAL as any);
    const last = prompt.messages[prompt.messages.length - 1];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(IMAGE_PART);
  });

  it("preserves array content from history user turns", async () => {
    const svc = createService([
      { role: "system", content: "sys" },
      { role: "user", content: MULTIMODAL },
      { role: "assistant", content: "sure" },
    ]);
    const prompt: any = await svc.createPrompt("next turn");
    const userMsgs = prompt.messages.filter((m: any) => m.role === "user");
    expect(Array.isArray(userMsgs[0].content)).toBe(true);
  });

  it("does not throw 'No valid messages' when the only user turn is multimodal", async () => {
    const svc = createService([{ role: "system", content: "sys" }]);
    const prompt: any = await svc.createPrompt(MULTIMODAL as any);

    await expect(svc.getAIResponse(prompt)).resolves.toBeDefined();

    // The image turn survived the validity filter and reached the provider.
    const sent = svc.ai.chat.completions.create.mock.calls[0][0];
    const userMsg = sent.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg.content)).toBe(true);
  });

  it("hasRenderableContent accepts multimodal content and rejects truly empty content", () => {
    const svc = createService();
    expect(svc.hasRenderableContent({ role: "user", content: MULTIMODAL })).toBe(true);
    expect(svc.hasRenderableContent({ role: "user", content: [IMAGE_PART] })).toBe(true);
    expect(svc.hasRenderableContent({ role: "user", content: [{ type: "text", text: "  " }] })).toBe(
      false,
    );
    expect(svc.hasRenderableContent({ role: "user", content: [] })).toBe(false);
    expect(svc.hasRenderableContent({ role: "user", content: "hi" })).toBe(true);
    expect(svc.hasRenderableContent({ role: "user", content: "   " })).toBe(false);
    // Tool turns remain valid regardless of content.
    expect(svc.hasRenderableContent({ role: "tool", content: "" })).toBe(true);
  });

  it("still throws when there is genuinely no user message", async () => {
    const svc = createService([{ role: "system", content: "sys" }]);
    const prompt = { model: "gpt-4o", messages: [{ role: "system", content: "sys" }] };
    await expect(svc.getAIResponse(prompt as any)).rejects.toThrow(
      "No valid messages found in prompt",
    );
  });
});
