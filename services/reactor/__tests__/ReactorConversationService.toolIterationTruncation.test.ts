import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import TaskModel from "@reactory/server-modules/reactory-core/models/Task";
import { StreamingMode } from "../types/streaming.types";
import { ToolApprovalMode } from "../../../ai/openai/types/chat";

/**
 * Truncation propagation through ReactorConversationService — the seam where
 * the defect actually lived.
 *
 * THE BUG THIS FILE PINS DOWN
 *
 * A provider whose tool loop runs out of budget returns a completion with
 * `finish_reason: 'max_tool_iterations'`. In the service that signal used to
 * die twice over:
 *
 *   1. `processAIResponse` flattens `{ choices: [{ message }] }` into a flat
 *      `ReactorChatMessage` and drops `choices` entirely, so the finish reason
 *      never left the provider wrapper. The AUTO loop then saw an ordinary
 *      "assistant said something, with tool_calls" turn and reported the run as
 *      COMPLETE — a truncated turn was indistinguishable from a finished one,
 *      which is how a reviewer could approve a partial fix.
 *
 *   2. The non-streaming "limit reached" flags were written to
 *      `response.choices[0].message`, which by that point does not exist on the
 *      flattened object. That branch matched nothing and was dead code, so even
 *      the outer loop's own limit produced no flag for any caller.
 *
 * The other suites cover the parsing helpers (`toolIterations.test.ts`), the
 * provider's own loop (`AnthropicService.toolIterations.test.ts`) and the
 * workflow step's reaction to an ALREADY-flagged response
 * (`AgentConversationStep.test.ts`). All three sit on one side or the other of
 * this seam. Restoring either half of the defect above would leave every one of
 * them green — hence this file. It drives the real `processAIResponse` and the
 * real AUTO branch of `sendMessage`; only the provider call, the persistence
 * primitives and the model layer are stubbed.
 *
 * The outer budget is deliberately set SMALL (5) while the provider reports a
 * larger one (200). That is what separates the two paths: if the provider's
 * truncation is detected the pause reports 200/200 and no tool is executed; if
 * it is missed, the outer loop grinds out 5 batches and reports 5/5 with
 * `executeMacro` having run — which is exactly what the assertions below
 * forbid.
 */

const RAW_TRUNCATED_COMPLETION = {
  id: "completion-1",
  object: "chat.completion",
  created: new Date(),
  // `buildToolLoopCompletion` puts the marker on the completion AND on the
  // message; the service must survive whichever shape reaches it.
  toolIterationLimitReached: true,
  finishReason: "max_tool_iterations",
  iterationsCompleted: 200,
  maxToolIterations: 200,
  choices: [
    {
      index: 0,
      finish_reason: "max_tool_iterations",
      message: {
        role: "assistant",
        content:
          "I've reached the maximum number of tool iterations (200). Here's what I have so far based on the tools I've used.",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
        iterationsCompleted: 200,
        maxToolIterations: 200,
      },
    },
  ],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

describe("ReactorConversationService - tool iteration truncation propagation", () => {
  const PERSONA = "ReactorAIPersona";
  let service: any;
  let sessionLog: jest.Mock;
  let conversation: any;
  let historyPushes: any[];

  /** A conversation the AUTO loop will act on, with a deliberately small outer budget. */
  const buildConversation = (): any => ({
    _id: new ObjectId(),
    personaId: PERSONA,
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    // Declared so the tool is executable: under the old (broken) behaviour the
    // loop WOULD run this batch, which is precisely what the test must catch.
    tools: [
      { type: "function", function: { name: "read_file", description: "read a file" } },
    ],
    macros: [],
    // 5, not 200: if the provider's truncation is not detected the outer loop
    // reaches its own limit and reports 5/5. The assertions distinguish the two.
    maxToolIterations: 5,
    toolApprovalMode: ToolApprovalMode.AUTO,
    // Left undefined so `processAIResponse` skips its auto-compaction block
    // (which would otherwise issue another findById) — maxTokens is not the
    // subject here.
    maxTokens: undefined,
    history: [],
    user: new ObjectId(),
  });

  const build = () => {
    conversation = buildConversation();
    historyPushes = [];

    // ---- model layer: capture every history append, never reach Mongo -----
    const chain = (result: any) => ({
      populate: () => ({ exec: async () => result }),
      lean: () => ({ exec: async () => result }),
      select: () => ({ lean: () => ({ exec: async () => result }) }),
      exec: async () => result,
    });

    jest.spyOn(ReactorConversationModel, "findOne").mockImplementation(((
      _filter: any,
      projection?: any,
    ) => {
      // The stored model/provider lookup passes a projection; the conversation
      // load does not.
      if (projection) {
        return chain({ providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" });
      }
      return chain(conversation);
    }) as any);

    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockImplementation(((
      _filter: any,
      update: any,
    ) => {
      const pushed = update?.$push?.history;
      if (pushed) {
        historyPushes.push(pushed);
        conversation.history.push(pushed);
      }
      return chain(conversation);
    }) as any);

    jest.spyOn(ReactorConversationModel, "findById").mockReturnValue(
      chain(conversation) as any,
    );
    jest.spyOn(ReactorConversationModel, "findByIdAndUpdate").mockReturnValue({
      exec: async () => conversation,
    } as any);

    // An existing pending approval task short-circuits the task-queue branch,
    // which would otherwise construct and save a real document.
    jest.spyOn(TaskModel, "findOne").mockReturnValue({
      exec: async () => ({ _id: new ObjectId(), status: "pending" }),
    } as any);

    // ---- the service, with collaborators stubbed ---------------------------
    service = Object.create(ReactorConversationService.prototype);

    sessionLog = jest.fn();
    service.sessionLog = sessionLog;
    service.context = {
      user: { _id: new ObjectId() },
      partner: { key: "reactory" },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      getService: jest.fn((id: string) => {
        if (id === "reactor.AIPersonaProvider@1.0.0") {
          return {
            getPersona: async () => ({
              id: PERSONA,
              name: "Reactor",
              providerId: "anthropic",
              modelId: "claude-sonnet-4-5-20250929",
              tools: conversation.tools,
              macros: [],
              config: {},
            }),
          };
        }
        // Everything else (usage telemetry, analytics) is absent.
        return null;
      }),
    };

    service.validateChatSessionId = jest.fn();
    service.cancelGraphingSchedule = jest.fn();
    service.beginTurnInterruptEpoch = jest.fn(() => 1);
    service.enforceUsageBudget = jest.fn(async () => null);
    service.isRetryableError = jest.fn(() => false);
    service.resolveConversationProvider = jest.fn(async () => "anthropic");

    // Persistence primitives — the subject is the propagation, not the stores.
    service.mirrorPersistedAppend = jest.fn(async () => {});
    service.updateConversationTokenCount = jest.fn(async () => {});
    service.buildUsageAttribution = jest.fn(async () => null);
    service.generateConversationTitle = jest.fn();
    service.validateConversationDocument = jest.fn();
    service.reconcileAbandonedClientToolsBeforeDispatch = jest.fn(async () => {});
    service.updateToolCallStatus = jest.fn(async () => {});
    service.updateTokenCountAndCheckLimits = jest.fn(async () => ({
      currentTokens: 10,
      maxTokens: 200_000,
      percentageUsed: 0.01,
      shouldTruncate: false,
      exceedsLimit: false,
    }));

    // The provider call: a completion whose tool loop was exhausted.
    service.executeProviderChat = jest.fn(async () => ({ ...RAW_TRUNCATED_COMPLETION }));

    // The tool executor. Under the correct behaviour it must never be reached.
      service.executeMacro = jest.fn(async () => ({ content: "should not run" }));

    service.providerService = {
      getAdapter: jest.fn(async () => ({
        // Mirrors the real Anthropic adapter: a flat ReactorChatMessage is
        // passed through untouched, which is how the flags survive to callers.
        adaptResponse: (response: any) =>
          response?.__typename === "ReactorChatMessage" ? response : null,
      })),
      resolveProviderCredentials: jest.fn(async () => ({ source: "none" })),
      resolveProviderForModel: jest.fn(async () => "anthropic"),
    };

    service.streamingSessionManager = {
      getSessionId: jest.fn(() => null),
      getSession: jest.fn(async () => null),
    };
    service.streamingTransportManager = {
      hasTransport: jest.fn(() => false),
      isChatSessionActive: jest.fn(async () => false),
      sendEventToSession: jest.fn(async () => {}),
    };

    return conversation._id.toString();
  };

  afterEach(() => {
    jest.restoreAllMocks();
    (ReactorConversationService as any).activeTurns?.clear?.();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  const pushedContents = () =>
    historyPushes.map((item: any) => String(item?.content ?? ""));

  const pauseMessages = () =>
    historyPushes.filter((item: any) =>
      String(item?.content ?? "").includes("reached the configured limit"),
    );

  describe("processAIResponse", () => {
    it("carries the provider's exhaustion into the flat ReactorChatMessage", async () => {
      build();

      const flat = await service.processAIResponse(
        { ...RAW_TRUNCATED_COMPLETION },
        conversation,
        "do the work",
        StreamingMode.NONE,
        Date.now(),
        { providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
      );

      // The response the AUTO loop and every caller downstream actually see.
      expect(flat.__typename).toBe("ReactorChatMessage");
      // `choices` is gone — this is the flattening that used to swallow the signal.
      expect(flat.choices).toBeUndefined();
      expect(flat.toolIterationLimitReached).toBe(true);
      expect(flat.iterationsCompleted).toBe(200);
      expect(flat.maxToolIterations).toBe(200);
      expect(flat.finishReason).toBe("max_tool_iterations");
      // The tool calls survive, which is why a truncated turn looks like a normal
      // one unless the marker is carried alongside them.
      expect(flat.tool_calls).toHaveLength(1);
      expect(flat.tool_calls[0].function.name).toBe("read_file");
    });

    it("does not mark a normal completion as truncated", async () => {
      build();

      const flat = await service.processAIResponse(
        {
          ...RAW_TRUNCATED_COMPLETION,
          toolIterationLimitReached: undefined,
          finishReason: undefined,
          iterationsCompleted: undefined,
          maxToolIterations: undefined,
          choices: [
            {
              index: 0,
              finish_reason: "end_turn",
              message: {
                role: "assistant",
                content: "done",
                tool_calls: [],
              },
            },
          ],
        },
        conversation,
        "do the work",
        StreamingMode.NONE,
        Date.now(),
        { providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
      );

      expect(flat.toolIterationLimitReached).toBeUndefined();
      expect(flat.finishReason).toBeUndefined();
      expect(flat.content).toBe("done");
    });
  });

  describe("AUTO branch of sendMessage", () => {
    it("detects a truncated provider response, does NOT re-run the batch, and reports the provider's counters", async () => {
      const chatSessionId = build();

      const result = await service.sendMessage({
        personaId: PERSONA,
        chatSessionId,
        message: "do the work",
        role: "user",
        streamingMode: StreamingMode.NONE,
      });

      // (b1) The already-executed batch must not be executed a second time. The
      // provider's tool loop ran these calls; re-dispatching them here is the
      // double-execution the guard exists to prevent.
      expect(service.executeMacro).not.toHaveBeenCalled();
      expect(service.updateToolCallStatus).not.toHaveBeenCalled();

      // (b2) The provider was called exactly once: no continuation turn was
      // requested for a batch that was never going to run.
      expect(service.executeProviderChat).toHaveBeenCalledTimes(1);

      // (b3) The caller receives a response carrying the marker and the
      // PROVIDER's own counters (200/200), not the outer loop's (5/5). Writing
      // the flags anywhere the caller cannot see them is the dead-code defect.
      expect(result).toBeDefined();
      expect(result.toolIterationLimitReached).toBe(true);
      expect(result.iterationsCompleted).toBe(200);
      expect(result.maxToolIterations).toBe(200);
      expect(result.componentFqn).toBe("core.WorkflowTaskApproval@1.0.0");

      // (b4) The pause is persisted into the transcript and says plainly that the
      // turn was truncated — "completed" alone is what made a capped run read as
      // a finished one.
      const pauses = pauseMessages();
      expect(pauses).toHaveLength(1);
      expect(String(pauses[0].content)).toContain("The turn was truncated");
      expect(String(pauses[0].content)).toContain("200");
      expect(pauses[0].role).toBe("assistant");

      // (b5) The service said so in its own log, naming the budget and the fact
      // that it was the provider's loop that ran out.
      const warning = sessionLog.mock.calls.find((call: any[]) =>
        String(call[1]).includes("AUTO tool execution reached max iterations"),
      );
      expect(warning).toBeDefined();
      expect(warning![2]).toMatchObject({
        iterationsCompleted: 200,
        iterationBudget: 200,
        truncatedByProvider: true,
      });
    });

    it("still executes a normal batch and does not report truncation", async () => {
      const chatSessionId = build();
      // A non-truncated turn with one tool call: the loop must run.
      service.executeProviderChat = (jest.fn() as any)
        .mockResolvedValueOnce({
          ...RAW_TRUNCATED_COMPLETION,
          toolIterationLimitReached: undefined,
          finishReason: undefined,
          iterationsCompleted: undefined,
          maxToolIterations: undefined,
          choices: [
            {
              index: 0,
              finish_reason: "tool_use",
              message: {
                role: "assistant",
                content: "reading",
                tool_calls: [
                  {
                    id: "t1",
                    type: "function",
                    function: { name: "read_file", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          ...RAW_TRUNCATED_COMPLETION,
          toolIterationLimitReached: undefined,
          finishReason: undefined,
          iterationsCompleted: undefined,
          maxToolIterations: undefined,
          choices: [
            {
              index: 0,
              finish_reason: "end_turn",
              message: { role: "assistant", content: "all done", tool_calls: [] },
            },
          ],
        });

      const result = await service.sendMessage({
        personaId: PERSONA,
        chatSessionId,
        message: "do the work",
        role: "user",
        streamingMode: StreamingMode.NONE,
      });

      // The control case: the guard must not suppress a legitimate batch.
      expect(service.executeMacro).toHaveBeenCalledTimes(1);
      expect(result.toolIterationLimitReached).toBeUndefined();
      expect(pauseMessages()).toHaveLength(0);
    });
  });
});
