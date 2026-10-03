import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import { StreamingMode } from "../types/streaming.types";

/**
 * Regression: the per-turn telemetry/usage block in `processAIResponse`.
 *
 * That block referenced `aiMessage`, which is declared inside the
 * `if (!response.__persisted)` guard and is therefore *out of scope* where the
 * block runs. Every turn threw `ReferenceError: aiMessage is not defined`; the
 * surrounding catch swallowed it into the benign-looking
 * "Failed to record AI usage telemetry" warning — but the throw aborted the
 * whole `try` **before `usageService.recordUsage(...)` ran**, so usage was
 * silently never recorded, on every turn, for every provider.
 *
 * These tests pin the two things that were broken:
 *   1. `recordUsage` actually runs (what the ReferenceError prevented);
 *   2. the tool-call telemetry reads the response's own message, including on
 *      the pre-persisted (streaming) path where the old variable was never even
 *      assigned.
 */
describe("ReactorConversationService - usage telemetry on processAIResponse", () => {
  let service: any;
  let conversation: any;
  let recordUsage: jest.Mock;
  let recordHistogram: jest.Mock;

  const build = (responseOverrides: Record<string, any> = {}) => {
    conversation = {
      _id: new ObjectId(),
      personaId: "ReactorAIPersona",
      user: new ObjectId(),
      providerId: "deepseek",
      modelId: "deepseek-chat",
      use_case: "standalone",
      // 0 disables the auto-compaction branch, whose DB reads are not the
      // subject here.
      maxTokens: 0,
    };

    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
      exec: async () => ({ _id: conversation._id, history: [] }),
    } as any);

    recordUsage = jest.fn(async () => ({}));
    recordHistogram = jest.fn();

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      telemetry: { increment: jest.fn(), recordHistogram },
      getService: jest.fn(() => ({ recordUsage })),
    };
    service.sessionLog = jest.fn();
    service.buildUsageAttribution = jest.fn(async () => ({}));
    service.mirrorPersistedAppend = jest.fn(async () => {});
    service.updateConversationTokenCount = jest.fn(async () => {});
    service.scheduleGraphing = jest.fn();

    const response: any = {
      id: "cmpl_1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [
              { id: "call_1", function: { name: "chart", arguments: "{}" } },
              { id: "call_2", function: { name: "d3", arguments: "{}" } },
            ],
          },
        },
      ],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      ...responseOverrides,
    };

    return response;
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("records usage — the ReferenceError previously aborted this", async () => {
    const response = build();

    await service.processAIResponse(response, conversation, "hi", StreamingMode.NONE);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(service.sessionLog).not.toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/Failed to record AI usage telemetry/i),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("attributes the turn's tool calls to the telemetry histogram", async () => {
    const response = build();

    await service.processAIResponse(response, conversation, "hi", StreamingMode.NONE);

    expect(recordHistogram).toHaveBeenCalledWith(
      "reactor_tool_calls_per_turn",
      2,
      expect.anything()
    );
  });

  it("reports toolCallsCount and toolsUsed on the usage row", async () => {
    const response = build();

    await service.processAIResponse(response, conversation, "hi", StreamingMode.NONE);

    const [payload] = (recordUsage as jest.Mock).mock.calls[0];
    expect(payload.toolCallsCount).toBe(2);
    expect(payload.toolsUsed).toEqual(expect.arrayContaining(["chart", "d3"]));
    expect(payload.promptTokens).toBe(100);
    expect(payload.completionTokens).toBe(20);
  });

  it("still records usage when the provider pre-persisted the message", async () => {
    // The streaming path sets __persisted and skips the inner persist block —
    // `aiMessage` was never assigned on that path, which is exactly why the fix
    // reads the tool calls from `response` rather than from that variable.
    const response = build({ __persisted: true });

    await service.processAIResponse(response, conversation, "hi", StreamingMode.NONE);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordHistogram).toHaveBeenCalledWith(
      "reactor_tool_calls_per_turn",
      2,
      expect.anything()
    );
  });

  it("does not record a tool-call histogram when the turn made no tool calls", async () => {
    const response = build();
    response.choices[0].message.tool_calls = [];

    await service.processAIResponse(response, conversation, "hi", StreamingMode.NONE);

    expect(recordHistogram).not.toHaveBeenCalledWith(
      "reactor_tool_calls_per_turn",
      expect.anything(),
      expect.anything()
    );
    const [payload] = (recordUsage as jest.Mock).mock.calls[0];
    expect(payload.toolCallsCount).toBe(0);
  });
});
