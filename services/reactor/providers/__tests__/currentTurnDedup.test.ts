import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import { ObjectId } from "mongodb";

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
  OpenAIService = (await import("../OpenAIService")).default;
});

function createService(history: any[]) {
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
  return svc;
}

const userTurnsIn = (prompt: any) => prompt.messages.filter((m: any) => m.role === "user");

describe("AIProviderBase.excludeInFlightTurn", () => {
  it("removes the persisted turn by id and leaves the rest of the transcript intact", () => {
    const turnId = new ObjectId().toString();
    const svc = createService([
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      { id: turnId, role: "user", content: "SECOND" },
    ]);

    expect(svc.excludeInFlightTurn(turnId)).toBe(1);
    expect(svc.chatState.history).toHaveLength(3);
    expect(svc.chatState.history.map((m: any) => m.content)).toEqual([
      "sys",
      "first",
      "first answer",
    ]);
  });

  it("is a no-op when no id is supplied (callers that do not persist first)", () => {
    const svc = createService([
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
    ]);

    expect(svc.excludeInFlightTurn(undefined)).toBe(0);
    expect(svc.excludeInFlightTurn(null)).toBe(0);
    expect(svc.chatState.history).toHaveLength(2);
  });

  it("is a no-op when the id is not present in the transcript", () => {
    const svc = createService([
      { id: new ObjectId().toString(), role: "user", content: "first" },
    ]);

    expect(svc.excludeInFlightTurn(new ObjectId().toString())).toBe(0);
    expect(svc.chatState.history).toHaveLength(1);
  });

  it("matches on identity, so an identical earlier turn is NOT dropped", () => {
    const turnId = new ObjectId().toString();
    const svc = createService([
      { id: new ObjectId().toString(), role: "user", content: "yes" },
      { role: "assistant", content: "ok" },
      { id: turnId, role: "user", content: "yes" },
    ]);

    expect(svc.excludeInFlightTurn(turnId)).toBe(1);
    // The earlier, legitimately repeated "yes" survives.
    expect(svc.chatState.history).toHaveLength(2);
    expect(svc.chatState.history[0].content).toBe("yes");
  });

  it("also matches a Mongo `_id` (the store exposes both id and _id)", () => {
    const turnId = new ObjectId().toString();
    const svc = createService([
      { role: "user", content: "first" },
      { _id: turnId, role: "user", content: "SECOND" },
    ]);

    expect(svc.excludeInFlightTurn(turnId)).toBe(1);
    expect(svc.chatState.history).toHaveLength(1);
  });

  it("tolerates a missing/empty history", () => {
    const svc = createService([]);
    expect(svc.excludeInFlightTurn("anything")).toBe(0);
  });
});

describe("prompt assembly — current turn is sent exactly once", () => {
  it("sends the turn once when the provider is told which turn is in flight", async () => {
    const turnId = new ObjectId().toString();
    const svc = createService([
      { role: "system", content: "sys" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      // The turn sendMessage already persisted + mirrored before this call.
      { id: turnId, role: "user", content: "SECOND QUESTION" },
    ]);

    svc.excludeInFlightTurn(turnId);
    const prompt: any = await svc.createPrompt("SECOND QUESTION");

    const copies = userTurnsIn(prompt).filter(
      (m: any) => m.content === "SECOND QUESTION",
    );
    expect(copies).toHaveLength(1);
    // The append is still the last message.
    expect(prompt.messages[prompt.messages.length - 1].content).toBe("SECOND QUESTION");
  });

  it("still appends when the turn is NOT in the transcript (compaction/audio/direct callers)", async () => {
    const svc = createService([
      { role: "system", content: "sys" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);

    // No id threaded → unchanged behaviour: the append is load-bearing.
    const prompt: any = await svc.createPrompt("SECOND QUESTION");
    const copies = userTurnsIn(prompt).filter(
      (m: any) => m.content === "SECOND QUESTION",
    );
    expect(copies).toHaveLength(1);
  });

  it("sends a screenshot once, not twice", async () => {
    const turnId = new ObjectId().toString();
    const IMAGE = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const turn = [{ type: "text", text: "see screenshot" }, IMAGE];

    const svc = createService([
      { role: "system", content: "sys" },
      { id: turnId, role: "user", content: turn },
    ]);

    svc.excludeInFlightTurn(turnId);
    const prompt: any = await svc.createPrompt(turn as any);

    const imageTurns = userTurnsIn(prompt).filter(
      (m: any) =>
        Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
    );
    expect(imageTurns).toHaveLength(1);
  });
});
