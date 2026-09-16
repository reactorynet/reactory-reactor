import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import { ObjectId } from "mongodb";

// Mock every provider SDK so module import never touches the network.
jest.unstable_mockModule("openai", () => ({
  __esModule: true,
  default: class OpenAI {
    chat = { completions: { create: jest.fn() } };
  },
}));

jest.unstable_mockModule("@google/genai", () => ({
  __esModule: true,
  default: class GoogleGenAI {
    chats = { create: jest.fn() };
  },
  GoogleGenAI: class GoogleGenAI {
    chats = { create: jest.fn() };
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  Type: {},
}));

jest.unstable_mockModule("ollama", () => ({
  __esModule: true,
  Ollama: class Ollama {},
}));

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

let OllamaAIService: any;
let GoogleAIService: any;
let AnthropicService: any;

beforeAll(async () => {
  // NOTE: AWSBedrockService is deliberately NOT imported here. It depends on
  // @aws-sdk/client-bedrock-runtime, which is not installed, and the service is
  // not wired into the provider registry (no references outside its own file).
  // Its multimodal handling is hardened in source but cannot be exercised until
  // that SDK is added and the service is registered.
  [OllamaAIService, GoogleAIService, AnthropicService] = await Promise.all([
    import("../OllamaAIService").then((m) => m.default),
    import("../GoogleAIService").then((m) => m.default),
    import("../AnthropicService").then((m) => m.default),
  ]);
});

const BASE64 = "iVBORw0KGgoAAAANSUhEUg==";
const DATA_URL = `data:image/png;base64,${BASE64}`;
const IMAGE_PART = { type: "image_url", image_url: { url: DATA_URL } };
const MULTIMODAL = [{ type: "text", text: "look at this screenshot" }, IMAGE_PART];

describe("OllamaAIService — multimodal", () => {
  it("lifts image parts onto the `images` array of the current turn", () => {
    const svc: any = new OllamaAIService({}, mockContext);
    svc.chatState = { history: [], files: [] };

    const messages = svc.buildMessages(MULTIMODAL);
    const last = messages[messages.length - 1];

    expect(last.role).toBe("user");
    expect(last.content).toBe("look at this screenshot");
    expect(last.images).toEqual([BASE64]);
  });

  it("converts historical multimodal user turns the same way", () => {
    const svc: any = new OllamaAIService({}, mockContext);
    svc.chatState = {
      files: [],
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: MULTIMODAL },
      ],
    };

    const messages = svc.buildMessages("next");
    const historyUser = messages.find((m: any) => m.role === "user" && m.images);
    expect(historyUser.images).toEqual([BASE64]);
    expect(historyUser.content).toBe("look at this screenshot");
  });

  it("omits `images` entirely for plain text turns", () => {
    const svc: any = new OllamaAIService({}, mockContext);
    svc.chatState = { history: [{ role: "user", content: "hi" }], files: [] };

    const messages = svc.buildMessages("hello");
    for (const m of messages) expect(m.images).toBeUndefined();
  });

  it("leaves a multimodal message untouched on retry", () => {
    const svc: any = new OllamaAIService({}, mockContext);
    const result = svc.modifyMessageForRetry(MULTIMODAL, { message: "tool call failed" });
    expect(result).toBe(MULTIMODAL);
  });
});

describe("GoogleAIService — multimodal", () => {
  it("converts a data-URL image part to inlineData", () => {
    const svc: any = new GoogleAIService({}, mockContext);

    const parts = svc.convertMessageToGoogleParts(MULTIMODAL);

    expect(parts).toEqual([
      { text: "look at this screenshot" },
      { inlineData: { mimeType: "image/png", data: BASE64 } },
    ]);
  });

  it("leaves a multimodal message untouched on retry", () => {
    const svc: any = new GoogleAIService({}, mockContext);
    const result = svc.modifyMessageForRetry(MULTIMODAL, { message: "unexpected_tool_call" });
    expect(result).toBe(MULTIMODAL);
  });
});

describe("AnthropicService — multimodal", () => {
  it("converts a data-URL image part to an Anthropic image block", () => {
    const svc: any = new AnthropicService({}, mockContext);

    const blocks = svc.translateContentBlocks(MULTIMODAL);

    expect(blocks).toEqual([
      { type: "text", text: "look at this screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: BASE64 } },
    ]);
  });

  it("keeps plain string content as-is", () => {
    const svc: any = new AnthropicService({}, mockContext);
    expect(svc.translateContentBlocks("hello")).toBe("hello");
  });
});
