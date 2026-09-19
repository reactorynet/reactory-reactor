import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * The forwarding plumbing for a client-routed tool call.
 *
 * `classifyUndeclaredToolCall` decides *whether* to forward; this covers what
 * happens next, which was previously inline in the AUTO loop and therefore reachable
 * only by standing up a provider, an SSE transport and Mongo. The consequence was
 * that the two things most likely to be silently wrong had no test at all:
 *
 *  - the **shape of the placeholder row**, which providers depend on — every
 *    `tool_call` must have a matching `tool` result, and the placeholder is what
 *    keeps the transcript valid while the browser works; and
 *  - the **event the client receives**, which is the only thing that tells the
 *    browser to run the tool.
 *
 * A placeholder with a missing `tool_call_id`, or an event naming the wrong tool,
 * would break the turn and leave no trace — which is exactly why this is worth
 * asserting rather than trusting.
 */
describe("ReactorConversationService - persistClientToolForwarding", () => {
  let service: any;
  let findOneAndUpdate: jest.Mock<any>;
  let persistedDoc: any;

  const conversationId = new ObjectId().toString();

  const toolCall = {
    id: "call_chart_1",
    type: "function",
    function: { name: "chart", arguments: '{"type":"bar","data":[1,2]}' },
  };

  const build = (streamingMode?: string) => {
    persistedDoc = { _id: conversationId, history: [] };

    findOneAndUpdate = jest.fn<any>(() => ({
      exec: async () => persistedDoc,
    }));
    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockImplementation(findOneAndUpdate as any);

    service = Object.create(ReactorConversationService.prototype);
    service.sessionLog = jest.fn();
    service.mirrorPersistedAppend = jest.fn(async () => {});
    service.streamingTransportManager = {
      sendEventToSession: jest.fn(async () => {}),
    };

    return {
      conversationId,
      toolCall,
      toolName: "chart",
      streamingMode,
      personaId: "ReactorAIPersona",
    };
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe("the placeholder row", () => {
    it("persists a tool-role history entry keyed on the tool call id", async () => {
      // The `tool_call_id` is load-bearing: `completeClientToolCalls` finds this row
      // by it in order to replace the placeholder with the real result. Without it
      // the browser's result could never be attached to the call.
      const args = build();
      await service.persistClientToolForwarding(args);

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const update = findOneAndUpdate.mock.calls[0][1] as any;
      const entry = update.$push.history;

      expect(entry.role).toBe("tool");
      expect(entry.tool_call_id).toBe("call_chart_1");
      expect(entry.tool_name).toBe("chart");
      expect(entry.tool_results).toEqual([]);
      expect(entry.id).toBeInstanceOf(ObjectId);
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it("names the tool in the placeholder content so the transcript is readable", async () => {
      const args = build();
      await service.persistClientToolForwarding(args);

      const entry = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;
      expect(entry.content).toContain("chart");
      expect(entry.content).toMatch(/browser/i);
    });

    it("targets the right conversation and bumps `updated`", async () => {
      const args = build();
      await service.persistClientToolForwarding(args);

      const [criteria, update] = findOneAndUpdate.mock.calls[0] as any[];
      expect(criteria).toEqual({ _id: conversationId });
      expect(update.$set.updated).toBeInstanceOf(Date);
    });

    it("requests the updated document so the mirror has a persisted row to key on", async () => {
      const args = build();
      await service.persistClientToolForwarding(args);

      const options = findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual({ new: true });
    });

    it("mirrors the placeholder itself — not `undefined` — so a stripped $push cannot lose the row", async () => {
      // The mirror is what makes the placeholder visible to the store-backed read paths; skipping it
      // would leave the placeholder in Mongo only, where reads no longer look.
      //
      // This assertion previously REQUIRED `undefined` as the third argument, which is precisely the
      // defect: `findOneAndUpdate` returns the document *without* the item that was pushed (the
      // write-path policy strips `$push.history` for an existing document), so `updated.history`
      // cannot identify what was written — note the fixture's `history: []` above, which is that
      // shape. Given no fallback, the mirror took its "nothing to mirror" branch and wrote no row,
      // leaving the assistant's `tool_call` unanswered in the store. Providers then reject every
      // later turn with a non-retryable 400. Asserting the bug is what let it ship, so this test now
      // asserts the item is supplied.
      const args = build();
      await service.persistClientToolForwarding(args);

      const pushed = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;

      expect(service.mirrorPersistedAppend).toHaveBeenCalledTimes(1);
      const [calledConversationId, calledDoc, calledFallback] =
        service.mirrorPersistedAppend.mock.calls[0] as any[];

      expect(calledConversationId).toBe(conversationId);
      expect(calledDoc).toBe(persistedDoc);

      // The fallback must BE the pushed item, so the row is keyed on an id the transcript also
      // carries. `toBe` (identity), not `toEqual`: a re-built lookalike would carry a different id
      // and the row would be unreconcilable with the message it represents.
      expect(calledFallback).toBe(pushed);
      expect(calledFallback).not.toBeUndefined();
      expect(calledFallback.tool_call_id).toBe("call_chart_1");

      // FAILS IF: the fallback is omitted, re-created, or is the stale document returned by Mongo.
    });
  });

  describe("the SSE forward", () => {
    it("emits a tool-call event naming the tool and carrying its arguments", async () => {
      const args = build("SSE");
      await service.persistClientToolForwarding(args);

      expect(service.streamingTransportManager.sendEventToSession).toHaveBeenCalledTimes(1);
      const [sessionId, event] = service.streamingTransportManager.sendEventToSession.mock.calls[0] as any[];

      expect(sessionId).toBe(conversationId);
      expect(JSON.stringify(event)).toContain("chart");
      expect(JSON.stringify(event)).toContain("call_chart_1");
      // The model's arguments must reach the browser intact — they *are* the tool
      // invocation.
      expect(JSON.stringify(event)).toContain("bar");
    });

    it("labels the event with the conversation so it routes to the right window", async () => {
      // An unlabelled event fails the client's session-routing rule and is dropped.
      const args = build("SSE");
      await service.persistClientToolForwarding(args);

      const [, event] = service.streamingTransportManager.sendEventToSession.mock.calls[0] as any[];
      expect(JSON.stringify(event)).toContain(conversationId);
    });

    it("serialises object-shaped arguments rather than dropping them", async () => {
      // Providers differ: some hand back a JSON string, some an object. An object
      // arriving unstringified would reach the client as `[object Object]`.
      const args = build("SSE");
      args.toolCall = {
        ...toolCall,
        function: { name: "chart", arguments: { type: "bar" } as any },
      };

      await service.persistClientToolForwarding(args);

      const [, event] = service.streamingTransportManager.sendEventToSession.mock.calls[0] as any[];
      expect(JSON.stringify(event)).toContain("bar");
    });

    it("emits nothing for a non-SSE mode", async () => {
      // There is no stream to carry the event; the client learns of the call from
      // the transcript instead. Emitting into a transport that cannot deliver would
      // be wasted work.
      const args = build("NONE");
      await service.persistClientToolForwarding(args);

      expect(service.streamingTransportManager.sendEventToSession).not.toHaveBeenCalled();
      // ...but the placeholder is still written.
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it("emits nothing when no streaming mode is supplied", async () => {
      const args = build(undefined);
      await service.persistClientToolForwarding(args);

      expect(service.streamingTransportManager.sendEventToSession).not.toHaveBeenCalled();
    });
  });

  describe("failure handling", () => {
    it("swallows an SSE transport failure and warns instead of throwing", async () => {
      // Deliberately asymmetric with the write. The placeholder is already durable,
      // so the transcript is valid; the client simply was not told yet and will find
      // the call through the pending-tool query. Losing the notification is
      // recoverable; failing the turn here would not be.
      const args = build("SSE");
      service.streamingTransportManager.sendEventToSession = jest.fn(async () => {
        throw new Error("transport closed");
      });

      await expect(service.persistClientToolForwarding(args)).resolves.toBeUndefined();

      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("failed to forward"),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it("still mirrors the placeholder when the SSE forward fails", async () => {
      const args = build("SSE");
      service.streamingTransportManager.sendEventToSession = jest.fn(async () => {
        throw new Error("transport closed");
      });

      await service.persistClientToolForwarding(args);

      expect(service.mirrorPersistedAppend).toHaveBeenCalledTimes(1);
    });

    it("propagates a persistence failure rather than pretending it forwarded", async () => {
      // The opposite choice from the SSE case, and deliberately so: without the
      // placeholder the turn must not continue as though the call had been handed
      // off, and the caller's error handling is better placed to decide than a
      // swallow here.
      const args = build("SSE");
      findOneAndUpdate.mockImplementation(() => ({
        exec: async () => {
          throw new Error("mongo unavailable");
        },
      }));
      jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockImplementation(findOneAndUpdate as any);

      await expect(service.persistClientToolForwarding(args)).rejects.toThrow("mongo unavailable");

      // And it did not attempt to forward a call that was never recorded.
      expect(service.streamingTransportManager.sendEventToSession).not.toHaveBeenCalled();
    });

    it("propagates a mirror failure, because the store would not know the call exists", async () => {
      const args = build("SSE");
      service.mirrorPersistedAppend = jest.fn(async () => {
        throw new Error("mirror failed");
      });

      await expect(service.persistClientToolForwarding(args)).rejects.toThrow("mirror failed");
    });
  });
});
