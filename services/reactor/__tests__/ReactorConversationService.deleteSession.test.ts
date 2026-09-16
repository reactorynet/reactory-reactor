import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * Durable form of the delete-prune safety property (design log §52.8).
 *
 * §52 found four store conversations whose owning Mongo document was gone — because the two delete
 * paths removed the document and left the message rows behind. The fix wired
 * `mirrorDeletedConversation` into both, with two deliberate safety properties that are asserted
 * here:
 *
 *  1. **Rows are pruned only when the document delete actually happened.** `deleteOne` is scoped to
 *     the current user, so a delete attempted by someone else (or against an id that is already
 *     gone) returns `deletedCount: 0`. Pruning rows then would destroy a transcript that still has
 *     an owner — the exact opposite of the fix's intent.
 *  2. **The prune is fail-open.** `deleteChatSession` wraps its whole body in a `try`, so a *throwing*
 *     mirror would turn a completed document delete into a reported failure. The mirror therefore
 *     must never throw, and that is pinned in the second suite — the two properties only compose
 *     safely together.
 *
 * This property was previously proven only by a runtime script against real data. That is weaker
 * evidence than it looks: the script needs a database, so it cannot run in CI, and it exercises the
 * behaviour once rather than guarding it against regression.
 *
 * No database is touched: the model is spied and the store is substituted, following the idiom in
 * `ReactorConversationService.toolLifecycle.test.ts`.
 */
describe("ReactorConversationService - deleteChatSession prunes rows only with the document", () => {
  let service: any;
  let userId: ObjectId;

  const stubDeleteOne = (result: any) =>
    jest.spyOn(ReactorConversationModel, "deleteOne").mockReturnValue({
      exec: jest.fn(async () => result),
    } as any);

  beforeEach(() => {
    userId = new ObjectId();

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: userId },
      telemetry: { increment: jest.fn() },
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    service.sessionLog = jest.fn();
    // The real mirror needs a database; substitute it. Its own behaviour is suite two.
    service.mirrorDeletedConversation = jest.fn(async () => 3);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("removes the message rows when the owner's document delete happened", async () => {
    stubDeleteOne({ deletedCount: 1 });
    const id = new ObjectId().toString();

    const result = await service.deleteChatSession({ id });

    expect(result).toBe(true);
    expect(service.mirrorDeletedConversation).toHaveBeenCalledTimes(1);
    expect(service.mirrorDeletedConversation).toHaveBeenCalledWith(id);
  });

  it("scopes the delete to the current user, so ownership is enforced by the database", async () => {
    const spy = stubDeleteOne({ deletedCount: 1 });
    const id = new ObjectId().toString();

    await service.deleteChatSession({ id });

    expect(spy).toHaveBeenCalledWith({ _id: id, user: service.context.user });
  });

  it("PRESERVES the rows when the document delete did NOT happen", async () => {
    // A delete attempted by a different user, or against an id that is already gone. The transcript
    // still belongs to someone, so the rows must survive.
    stubDeleteOne({ deletedCount: 0 });
    const id = new ObjectId().toString();

    const result = await service.deleteChatSession({ id });

    expect(result).toBe(false);
    expect(service.mirrorDeletedConversation).not.toHaveBeenCalled();
  });

  it("neither reports success nor prunes when the delete throws", async () => {
    jest.spyOn(ReactorConversationModel, "deleteOne").mockReturnValue({
      exec: jest.fn(async () => {
        throw new Error("connection lost");
      }),
    } as any);
    const id = new ObjectId().toString();

    const result = await service.deleteChatSession({ id });

    expect(result).toBe(false);
    expect(service.mirrorDeletedConversation).not.toHaveBeenCalled();
  });

  it("does not increment the delete counter when nothing was deleted", async () => {
    stubDeleteOne({ deletedCount: 0 });

    await service.deleteChatSession({ id: new ObjectId().toString() });

    expect(service.context.telemetry.increment).not.toHaveBeenCalled();
  });
});

describe("ReactorConversationService - mirrorDeletedConversation is fail-open", () => {
  let service: any;

  beforeEach(() => {
    service = Object.create(ReactorConversationService.prototype);
    service.context = { user: { _id: new ObjectId() } };
    service.sessionLog = jest.fn();
    // NOTE: mirrorDeletedConversation itself is NOT substituted here — this suite exercises the real
    // method, with only the store beneath it stubbed via the lazily-held `messageMirror`.
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("prunes the conversation's rows and reports how many went", async () => {
    const deleteForConversation = jest.fn(async () => 4);
    service.messageMirror = { isAvailable: () => true, deleteForConversation };

    const deleted = await service.mirrorDeletedConversation("6aa91086ac8470a546715611");

    expect(deleted).toBe(4);
    expect(deleteForConversation).toHaveBeenCalledWith("6aa91086ac8470a546715611");
  });

  it("is a no-op when the store is unavailable, rather than failing the delete", async () => {
    service.messageMirror = { isAvailable: () => false };

    await expect(service.mirrorDeletedConversation("6aa91086ac8470a546715611")).resolves.toBe(0);
  });

  it("MUST NOT throw when the store fails — a throwing mirror would report a completed delete as failed", async () => {
    service.messageMirror = {
      isAvailable: () => true,
      deleteForConversation: jest.fn(async () => {
        throw new Error("store down");
      }),
    };

    await expect(service.mirrorDeletedConversation("6aa91086ac8470a546715611")).resolves.toBe(0);
    expect(service.sessionLog).toHaveBeenCalled();
  });

  it("does nothing for an empty id, so it cannot prune the wrong conversation", async () => {
    const deleteForConversation = jest.fn(async () => 9);
    service.messageMirror = { isAvailable: () => true, deleteForConversation };

    await expect(service.mirrorDeletedConversation("")).resolves.toBe(0);
    expect(deleteForConversation).not.toHaveBeenCalled();
  });
});
