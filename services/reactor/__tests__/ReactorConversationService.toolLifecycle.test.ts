import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

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
    it("atomically updates the tool_call status in history using arrayFilters", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
        exec: jest.fn(async () => ({} as any)),
      } as any);

      const sessionId = new ObjectId().toString();
      const callId = "call_abc123";

      await service.updateToolCallStatus(sessionId, callId, "running");

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: sessionId,
          "history.tool_calls.id": callId,
        },
        {
          $set: {
            "history.$[msg].tool_calls.$[tc].status": "running",
            updated: expect.any(Date),
          },
        },
        {
          arrayFilters: [
            { "msg.tool_calls.id": callId },
            { "tc.id": callId },
          ],
        }
      );
    });

    it("handles success and error status updates", async () => {
      const mockFindOneAndUpdate = jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
        exec: jest.fn(async () => ({} as any)),
      } as any);

      const sessionId = new ObjectId().toString();
      const callId = "call_xyz789";

      await service.updateToolCallStatus(sessionId, callId, "success");
      expect(mockFindOneAndUpdate).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({
            "history.$[msg].tool_calls.$[tc].status": "success",
          }),
        }),
        expect.anything()
      );

      await service.updateToolCallStatus(sessionId, callId, "error");
      expect(mockFindOneAndUpdate).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({
            "history.$[msg].tool_calls.$[tc].status": "error",
          }),
        }),
        expect.anything()
      );
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
