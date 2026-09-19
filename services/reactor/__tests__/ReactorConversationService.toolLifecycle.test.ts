import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import TaskModel from "@reactory/server-modules/reactory-core/models/Task";

describe("ReactorConversationService - Tool Call State Tracking & Lifecycle", () => {
  let service: any;
  let mockContext: any;

  beforeEach(() => {
    mockContext = {
      getService: jest.fn(),
      user: {
        _id: new ObjectId(),
        id: "u1",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      hasAnyRole: jest.fn(() => true),
    };

    service = Object.create(ReactorConversationService.prototype);

    // The same reasoning as `TaskModel` above, for the mirror: `mirrorPersistedAppend`
    // lazily requires the models barrel and constructs a real message-store client, so
    // leaving it live made `interruptToolExecution` spend ~1.7 s loading a module
    // registry and probing an unavailable database. It fails open, so the test passed —
    // it just did a second of real I/O to assert a synchronous outcome. These tests
    // assert on model calls, not on mirroring, so it is stubbed wholesale.
    service.mirrorPersistedAppend = jest.fn(async () => {});

    // `continueToolExecution` and `interruptToolExecution` both settle pending
    // workflow-approval tasks before doing anything else:
    //
    //   await TaskModel.updateMany({ ... }, { ... }).exec();
    //
    // That call is best-effort in production — its failure is caught and warned —
    // so leaving it unstubbed does not *fail* these tests. It does something worse:
    // the model has no connection, so mongoose buffers the operation until its
    // default `bufferTimeoutMS` of 10_000 ms before rejecting. Two tests therefore
    // took 10.0 s and 11.4 s of real wall-clock to assert a handful of synchronous
    // outcomes, and only passed because a timeout was raised. A unit test must not
    // reach a real database at all.
    jest.spyOn(TaskModel, "updateMany").mockReturnValue({
      exec: jest.fn(async () => ({ modifiedCount: 0 })),
    } as any);

    service = Object.create(ReactorConversationService.prototype);
    service.context = mockContext;
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
    service.sendMessage = jest.fn(async () => ({
      __typename: "ReactorChatMessage",
      content: "resumed",
    }));
    service.streamingTransportManager = {
      hasTransport: jest.fn(async () => false),
      sendEventToSession: jest.fn(async () => {}),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("updateToolCallStatus", () => {
    it("writes the status to the message store and NOT to the embedded array", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate");
      service.mirrorToolCallStatus = jest.fn(async () => {});

      const sessionId = new ObjectId().toString();
      const callId = "call_abc123";

      await service.updateToolCallStatus(sessionId, callId, "running");

      // The arrayFilters update is gone: the embedded array is retired, so a filter over
      // `history.tool_calls.id` would match nothing and the status change would be lost. The store
      // mirror is the write.
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(service.mirrorToolCallStatus).toHaveBeenCalledWith(sessionId, callId, "running");
    });

    it("handles success and error status updates", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate");
      service.mirrorToolCallStatus = jest.fn(async () => {});

      const sessionId = new ObjectId().toString();
      const callId = "call_xyz789";

      await service.updateToolCallStatus(sessionId, callId, "success");
      expect(service.mirrorToolCallStatus).toHaveBeenLastCalledWith(sessionId, callId, "success");

      await service.updateToolCallStatus(sessionId, callId, "error");
      expect(service.mirrorToolCallStatus).toHaveBeenLastCalledWith(sessionId, callId, "error");

      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("gracefully ignores empty sessionId or callId", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate");

      await service.updateToolCallStatus("", "call_123", "running");
      await service.updateToolCallStatus("sess_123", "", "running");

      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("continueToolExecution", () => {
    it("guards against double execution when the conversation is already processing", async () => {
      jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn(async () => ({
              _id: new ObjectId(),
              processing: true,
            })),
          }),
        }),
      } as any);

      const result = await service.continueToolExecution("sess_1", "reactor");

      expect(result.__typename).toBe("ReactorChatMessage");
      expect(result.content).toBe("Tool execution is already in progress.");
      expect(service.sendMessage).not.toHaveBeenCalled();
    });

    it("proceeds to sendMessage when conversation is not processing", async () => {
      jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn(async () => ({
              _id: new ObjectId(),
              processing: false,
            })),
          }),
        }),
      } as any);

      const result = await service.continueToolExecution("sess_1", "reactor");

      expect(service.sendMessage).toHaveBeenCalledTimes(1);
      expect(result.__typename).toBe("ReactorChatMessage");
      expect(result.content).toBe("resumed");
    });
  });

  describe("interruptToolExecution", () => {
    it("clears the processing flag on the conversation", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
        exec: jest.fn(async () => ({})),
      } as any);

      jest.spyOn(ReactorConversationModel, "findById").mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn(async () => ({
            history: [{ id: new ObjectId(), role: "assistant", content: "Interrupted" }],
          })),
        }),
      } as any);

      const sessionId = new ObjectId().toString();
      await service.interruptToolExecution(sessionId, "reactor", "User cancelled");

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: sessionId },
        { $set: { processing: false, updated: expect.any(Date) } }
      );
    });
  });
});
