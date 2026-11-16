import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

/**
 * R1 regression guard — `processToolCalls` in `factory.ts`.
 *
 * The review caught that my earlier "R1" test drove `OpenAIService.normalizeCompletion`,
 * which is the N2 site. Nothing exercised `processToolCalls`, which is where R1 actually
 * was: the guard that skips a call with an `id` but neither `type` nor `function`.
 *
 * Without the `!toolCall.function` clause, such a call reaches
 * `toolDef.function.name === toolCall.function.name` and throws `TypeError`, and because
 * that happens inside the loop, EVERY tool result for the turn is lost — not just the
 * malformed one. That is the behaviour pinned here.
 *
 * `MacroRegistry` is module state (populated by the macro barrel). It is stubbed through
 * `jest.mock` so the test does not depend on which macros happen to be registered, and
 * `executeToolCall` is stubbed so no macro actually runs.
 */

const KEY = "OPENAI_API_KEY";
const savedKey = process.env[KEY];

// Stub the registry: one macro whose single tool name matches the valid call below.
jest.mock("@reactory/server-modules/reactory-reactor/ai/macro", () => {
  const macro = {
    nameSpace: "macro",
    name: "search",
    version: "1.0.0",
    tools: [
      {
        type: "function",
        function: { name: "macro.search", description: "search", parameters: { type: "object", properties: {} } },
      },
    ],
  };
  const MacroRegistry: any = [macro];
  MacroRegistry.forEach = Array.prototype.forEach.bind(MacroRegistry);
  MacroRegistry.find = Array.prototype.find.bind(MacroRegistry);

  return {
    __esModule: true,
    default: MacroRegistry,
    MacroRegistry,
    getMacro: jest.fn(async () => ({ ok: true })),
  };
});

let processToolCalls: any;

beforeAll(async () => {
  // Deleted so importing factory.ts cannot trip the openai credential check.
  delete process.env[KEY];
  const mod = await import("../factory");
  processToolCalls = mod.processToolCalls;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
});

const completionWith = (toolCalls: any[]) =>
  ({
    id: "chatcmpl-r1",
    model: "gpt-4o",
    created: 1,
    choices: [
      { index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: toolCalls } },
    ],
  }) as any;

const state: any = {
  modelId: "gpt-4o",
  apiKey: "sk-test",
  toolApprovalMode: "auto",
  history: [],
  macros: [],
  vars: {},
};

describe("R1 — processToolCalls survives a malformed tool call", () => {
  it("does not throw when a call has an id but no type and no function", async () => {
    const completion = completionWith([
      // The shape a pass-through OpenAI-compatible provider can emit.
      { id: "call_broken" },
      { id: "call_good", type: "function", function: { name: "macro.search", arguments: "{}" } },
    ]);

    // The load-bearing assertion: no TypeError escaping, which is what lost the batch.
    await expect(processToolCalls(completion, state)).resolves.toBeDefined();
  });

  it("still produces a result for the valid call alongside the malformed one", async () => {
    const completion = completionWith([
      { id: "call_broken" },
      { id: "call_good", type: "function", function: { name: "macro.search", arguments: "{}" } },
    ]);

    const results = await processToolCalls(completion, state);

    // The malformed call is skipped OUTRIGHT — it contributes no result at all — while
    // the valid call must still be answered. Before the fix, zero results came back.
    const ids = results.map((r: any) => r.tool_call_id);
    expect(ids).toContain("call_good");
    expect(ids).not.toContain("call_broken");
  });

  it("skips a custom tool call without dropping the batch", async () => {
    const completion = completionWith([
      { id: "call_custom", type: "custom", custom: { name: "freeform", input: "x" } },
      { id: "call_good", type: "function", function: { name: "macro.search", arguments: "{}" } },
    ]);

    const results = await processToolCalls(completion, state);
    const ids = results.map((r: any) => r.tool_call_id);
    expect(ids).toContain("call_good");
    expect(ids).not.toContain("call_custom");
  });
});
