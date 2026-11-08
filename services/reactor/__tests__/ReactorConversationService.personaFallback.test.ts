import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import TaskModel from "@reactory/server-modules/reactory-core/models/Task";

/**
 * The persona fallback in `sendMessage` — the path that killed the server.
 *
 * A tool-iteration-limit approval task is raised without `personaId`, so
 * `continueToolExecution(chatSessionId, undefined)` re-enters `sendMessage` with a
 * perfectly valid conversation id and no persona. `sendMessage`'s fallback exists
 * exactly for that case: it re-reads the stored session to recover the persona.
 *
 * It called `getChatSession(chatSessionId)` — positionally, with a string — while
 * the method destructures `{ id }`. `id` became `undefined`, the guard reported
 * "Invalid conversation ID format: undefined", and because `TaskResolver` resumes
 * the turn with `void conversationService.continueToolExecution(...)` the rejection
 * was unhandled and `server.ts`'s `unhandledRejection` handler exited the process.
 *
 * These tests pin the behaviour rather than the source text:
 *
 *  1. the fallback resolves the persona and calls `getChatSession` with `{ id }`;
 *  2. `continueToolExecution(validId, undefined)` — the exact approval path — does
 *     not reject;
 *  3. a positional string is rejected loudly and before any database read, so the
 *     next such mistake fails at the call site instead of after a round-trip;
 *  4. `validateChatSessionId` runs *before* the fallback, so a malformed id raises
 *     the standard `ReactorErrorCode` failure and the fallback never sees it.
 */
describe("ReactorConversationService - sendMessage persona fallback", () => {
  let service: any;

  /**
   * Thrown from `sessionLog` once the turn has passed the fallback. It unwinds the
   * turn deterministically at exactly the point the tests observe, without standing
   * up a provider, an SSE transport or Mongo.
   */
  const STOP = "__stop_turn_after_fallback__";

  beforeEach(() => {
    const mockContext: any = {
      getService: jest.fn(),
      user: { _id: new ObjectId(), id: "u1", firstName: "Ada", lastName: "Lovelace" },
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      hasAnyRole: jest.fn(() => true),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = mockContext;
    // The real `validateChatSessionId` is inherited from the prototype and is part of
    // what is under test, so it is deliberately not stubbed. These three are side
    // effects the fallback path reaches before any provider work and are not under
    // test here.
    service.enforceUsageBudget = jest.fn(async () => null);
    service.cancelGraphingSchedule = jest.fn();
    service.beginTurnInterruptEpoch = jest.fn(() => 0);
    service.sessionLog = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Settle a promise to its error (or `null`) without relying on `any` callbacks. */
  const settle = async (promise: Promise<any>): Promise<Error | null> => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err as Error;
    }
  };

  /** Capture `sessionLog` lines and unwind the turn at the first "Sending message". */
  const logAndStopAtTurnStart = (): Array<{ level: string; message: string; meta: any }> => {
    const lines: Array<{ level: string; message: string; meta: any }> = [];
    service.sessionLog = jest.fn((level: string, message: string, meta: any) => {
      lines.push({ level, message, meta });
      if (message === "Sending message") throw new Error(STOP);
    });
    return lines;
  };

  /**
   * The `ReactorConversationModel.findOne(...).select(...).lean().exec()` chain that
   * `continueToolExecution` uses to read `processing`. No database is required.
   */
  const stubConversationLookup = (): void => {
    const result: any = null;
    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      select: (): any => ({ lean: (): any => ({ exec: async (): Promise<any> => result }) }),
      lean: (): any => ({ exec: async (): Promise<any> => result }),
      exec: async (): Promise<any> => result,
    } as any);
    jest.spyOn(TaskModel, "updateMany").mockReturnValue({
      exec: async (): Promise<any> => ({ modifiedCount: 0 }),
    } as any);
  };

  it("resolves the persona from the stored session and calls getChatSession({ id })", async () => {
    const chatSessionId = new ObjectId().toString();
    const getChatSession = jest.fn(async (args: any) => ({
      _id: args.id,
      personaId: "ReactorAIPersona",
    }));
    service.getChatSession = getChatSession;
    const lines = logAndStopAtTurnStart();

    // The turn unwinds at the sentinel — what matters is that it got that far at all.
    // On the broken commit it rejected with "Invalid conversation ID format: undefined"
    // before the turn ever started.
    await expect(
      service.sendMessage({
        chatSessionId,
        personaId: undefined,
        role: "user",
        message: "resume the tool execution",
      })
    ).rejects.toThrow(STOP);

    expect(getChatSession).toHaveBeenCalledTimes(1);
    // The regression: an object carrying the id, not the bare string.
    expect(getChatSession.mock.calls[0][0]).toEqual({ id: chatSessionId });

    const turnStart = lines.find((line) => line.message === "Sending message");
    expect(turnStart).toBeDefined();
    expect(turnStart!.meta.personaId).toBe("ReactorAIPersona");
  });

  it("does not throw 'Invalid conversation ID format' when personaId is omitted", async () => {
    const chatSessionId = new ObjectId().toString();
    service.getChatSession = jest.fn(async () => ({ personaId: "ReactorAIPersona" }));
    logAndStopAtTurnStart();

    const error = await settle(
      service.sendMessage({ chatSessionId, role: "user", message: "continue" })
    );

    expect(error).not.toBeNull();
    expect(String(error?.message)).not.toMatch(/Invalid conversation ID format/);
    expect(String(error?.message)).toBe(STOP);
  });

  it("continueToolExecution(validId, undefined) — the approval path — resolves", async () => {
    const chatSessionId = new ObjectId().toString();
    stubConversationLookup();

    // `sendMessage` is stubbed here because the assertion is about
    // `continueToolExecution` not rejecting on an absent persona; `sendMessage`'s own
    // fallback is driven for real above.
    const sendMessage = jest.fn(async (args: any) => ({
      role: "assistant",
      content: "resumed",
      args,
    }));
    service.sendMessage = sendMessage;

    await expect(
      service.continueToolExecution(chatSessionId, undefined)
    ).resolves.toMatchObject({ role: "assistant", content: "resumed" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      chatSessionId,
      personaId: undefined,
    });
  });

  it("continueToolExecution(validId, undefined) never surfaces 'Invalid conversation ID format'", async () => {
    const chatSessionId = new ObjectId().toString();
    stubConversationLookup();

    // The real `sendMessage` runs, with the stored-session read stubbed so no
    // database is required; it unwinds at the turn-start sentinel.
    const getChatSession = jest.fn(async (args: any) => ({
      personaId: "ReactorAIPersona",
      id: args.id,
    }));
    service.getChatSession = getChatSession;
    logAndStopAtTurnStart();

    const error = await settle(service.continueToolExecution(chatSessionId, undefined));

    expect(getChatSession).toHaveBeenCalledWith({ id: chatSessionId });
    expect(String(error?.message)).not.toMatch(/Invalid conversation ID format/);
  });

  it("getChatSession called with a positional string fails loudly, before any database read", async () => {
    const chatSessionId = new ObjectId().toString();
    const findOne = jest.spyOn(ReactorConversationModel, "findOne");

    await expect((service.getChatSession as any)(chatSessionId)).rejects.toThrow(
      /Invalid conversation ID format/
    );

    // The guard must fire before the round-trip: the point is a fast, legible failure
    // at the call site, not a confusing "undefined" after a query.
    expect(findOne).not.toHaveBeenCalled();
  });

  it("validates chatSessionId before the persona fallback runs", async () => {
    const getChatSession = jest.fn(async () => ({ personaId: "ReactorAIPersona" }));
    service.getChatSession = getChatSession;

    // A malformed id with no persona is precisely the shape that used to reach the
    // fallback and produce the raw `Invalid conversation ID format: undefined`.
    await expect(
      service.sendMessage({
        chatSessionId: "not-an-object-id",
        personaId: undefined,
        role: "user",
        message: "continue",
      })
    ).rejects.toThrow(/Invalid chat session ID format/);

    expect(getChatSession).not.toHaveBeenCalled();
  });
});
