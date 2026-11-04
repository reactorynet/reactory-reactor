
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * The SSE transport gate in `sendMessage`, and why it must not apply to a
 * server-owned continuation.
 *
 * THE DEFECT THIS FILE PINS DOWN
 *
 * `sendMessage` checks that a live SSE transport exists before doing any provider
 * work. When it does not, it returns a `ReactorInitiateSSE` response so the client
 * can reconnect and re-send. That is correct for a USER turn — and the live
 * session that opened REACTORY-302016408/20261104/523706518 shows the contract
 * working: the refusal, the client re-registering ~600 ms later, and the re-send.
 *
 * A client-tool continuation has no re-send. It is started by
 * `completeClientToolCalls` in an *un-awaited* background task, after the browser
 * has already reported its results. Nobody will ever send it again. So the same
 * gate does not defer that turn, it discards it: the assistant `tool_call` stays
 * answered in the transcript with no reply, and the client waits on a stream that
 * will never emit. Nothing was logged, which is why the ticket read for two days
 * as a silent provider stall — the last line in the session log was the
 * provider-routing decision, because no provider request was ever made.
 *
 * The observable that distinguishes the two outcomes is
 * `Finding existing conversation`: it is logged immediately after the gate and
 * before any persistence or provider work, so its presence means the gate let the
 * turn through and its absence means the turn was abandoned there.
 */
describe("ReactorConversationService - SSE transport gate", () => {
  const PERSONA = "ReactorAIPersona";
  let service: any;
  let sessionLog: jest.Mock;

  const build = (options: {
    role: "user" | "tool";
    continueAfterTools: boolean;
    /** Forces the gate to refuse, reproducing the transport-recycle window. */
    transport: { sessionId: string | null; session: any; hasTransport: boolean };
    /** Throw from the conversation load to stop the turn just past the gate. */
    stopAfterGate?: boolean;
  }) => {
    const conversation = {
      _id: new ObjectId(),
      personaId: PERSONA,
      providerId: "deepseek",
      modelId: "deepseek-flash",
      tools: [],
      macros: [],
      history: [],
    };
    const chatSessionId = conversation._id.toString();

    // Two different `findOne` shapes reach this service: the stored model/provider
    // lookup passes a projection, the conversation load does not. Dispatching on
    // that keeps the sentinel precise — it fires only once the gate has been
    // passed and the turn is committed to real work.
    jest.spyOn(ReactorConversationModel, "findOne").mockImplementation(((
      _filter: any,
      projection?: any,
    ) => {
      if (projection) {
        return {
          lean: () => ({
            exec: async () => ({ providerId: "deepseek", modelId: "deepseek-flash" }),
          }),
        };
      }
      if (options.stopAfterGate) throw new Error("STOP_AFTER_GATE");
      return {
        populate: () => ({ exec: async () => conversation }),
        exec: async () => conversation,
      };
    }) as any);

    jest.spyOn(ReactorConversationModel, "findById").mockReturnValue({
      lean: () => ({ exec: async () => conversation }),
      populate: () => ({ exec: async () => conversation }),
      select: () => ({ lean: () => ({ exec: async () => conversation }) }),
      exec: async () => conversation,
    } as any);

    // The failure path (once the sentinel below unwinds the turn) clears the
    // conversation's `processing` flag through this model call; unstubbed it would
    // reach a real Mongo connection and hang the suite rather than fail it.
    jest.spyOn(ReactorConversationModel, "findByIdAndUpdate").mockReturnValue({
      exec: async () => conversation,
    } as any);

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      // `createInitiateSSEResponse` binds the tenant key into the SSE URL, and the
      // URL builder reads it off the request context.
      partner: { key: "reactory", publicKey: "public-key" },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      getService: jest.fn(() => ({
        getPersona: async () => ({
          id: PERSONA,
          providerId: "deepseek",
          modelId: "deepseek-flash",
        }),
      })),
    };

    sessionLog = jest.fn();
    service.sessionLog = sessionLog;
    service.validateChatSessionId = jest.fn();
    service.cancelGraphingSchedule = jest.fn();
    service.beginTurnInterruptEpoch = jest.fn(() => 1);
    service.resolveConversationProvider = jest.fn(async () => "deepseek");
    service.enforceUsageBudget = jest.fn(async () => null);
    // A non-retryable classification keeps the sentinel from being retried three
    // times with exponential backoff.
    service.isRetryableError = jest.fn(() => false);

    // The subject: the presentation channel is mid-recycle.
    service.streamingSessionManager = {
      getSessionId: jest.fn(() => options.transport.sessionId),
      getSession: jest.fn(async () => options.transport.session),
      // Reached only on the user-turn path, where the gate refuses and the
      // service builds an SSE-init response for the client to reconnect with.
      createSession: jest.fn(async (descriptor: any) => ({
        sessionId: "sse-init",
        conversationId: descriptor.conversationId,
        status: "active",
        userId: descriptor.userId,
        transport: "sse",
        capabilities: descriptor.capabilities,
      })),
    };
    service.streamingTransportManager = {
      hasTransport: jest.fn(() => options.transport.hasTransport),
    };

    return { chatSessionId, personaId: PERSONA };
  };

  const loggedLines = () =>
    sessionLog.mock.calls.map((call: any[]) => String(call[1]));

  const reachedGateExit = () =>
    loggedLines().some((line) => line.includes("Finding existing conversation"));

  const drive = async (options: Parameters<typeof build>[0]) => {
    const args = build(options);
    let result: any;
    let thrown: any;
    try {
      result = await service.sendMessage({
        ...args,
        message: "",
        role: options.role,
        continueAfterTools: options.continueAfterTools,
        streamingMode: "SSE",
      });
    } catch (error: any) {
      thrown = error;
    }
    return { result, thrown, args };
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    // Pin the continuation wait to zero: every gate assertion below is about the
    // *decision*, and the default window exists only to give the client time to
    // re-attach. Left at its default this suite would spend 5 s per case waiting
    // for a transport that the fixture deliberately withholds.
    process.env.REACTOR_CONTINUATION_TRANSPORT_WAIT_MS = "0";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.REACTOR_CONTINUATION_TRANSPORT_WAIT_MS;
  });

  const noTransport = { sessionId: null, session: null, hasTransport: false };

  it("abandons a USER turn with no transport, and says so", async () => {
    const { result } = await drive({
      role: "user",
      continueAfterTools: false,
      transport: noTransport,
    });

    // The documented contract for a user send is unchanged: hand back an
    // SSE-init response and let the client reconnect and re-send.
    expect(result).toBeDefined();
    expect(reachedGateExit()).toBe(false);

    // ...but the refusal is no longer silent. Its absence is what made a
    // discarded turn look like a stalled provider.
    const refusal = sessionLog.mock.calls.find((call: any[]) =>
      String(call[1]).includes("returning an SSE-init response"),
    );
    expect(refusal).toBeDefined();
    expect(refusal![2]).toMatchObject({
      reason: "no-session-id",
      continueAfterTools: false,
      role: "user",
    });
  });

  it("does NOT abandon a client-tool continuation with no transport", async () => {
    await drive({
      role: "tool",
      continueAfterTools: true,
      transport: noTransport,
      stopAfterGate: true,
    });

    // The heart of the defect: the turn must get past the gate even though there
    // is nowhere to stream it. Nothing would ever re-send it.
    expect(reachedGateExit()).toBe(true);
  });

  it("reports the precise reason a continuation had no transport", async () => {
    await drive({
      role: "tool",
      continueAfterTools: true,
      transport: { sessionId: "sse-1", session: { id: "sse-1" }, hasTransport: false },
      stopAfterGate: true,
    });

    const warning = sessionLog.mock.calls.find((call: any[]) =>
      String(call[1]).includes("no SSE transport for a server-owned continuation"),
    );
    expect(warning).toBeDefined();
    expect(warning![0]).toBe("warn");
    expect(warning![2]).toMatchObject({ reason: "no-transport", continueAfterTools: true });
  });

  it("distinguishes a missing session from a missing session id", async () => {
    await drive({
      role: "tool",
      continueAfterTools: true,
      transport: { sessionId: "sse-9", session: null, hasTransport: false },
      stopAfterGate: true,
    });

    const warning = sessionLog.mock.calls.find((call: any[]) =>
      String(call[1]).includes("no SSE transport for a server-owned continuation"),
    );
    expect(warning![2]).toMatchObject({ reason: "no-session" });
  });

  it("proceeds straight through when a transport is present", async () => {
    await drive({
      role: "tool",
      continueAfterTools: true,
      transport: { sessionId: "sse-1", session: { id: "sse-1" }, hasTransport: true },
      stopAfterGate: true,
    });

    expect(reachedGateExit()).toBe(true);
    // No refusal should be reported at all.
    expect(
      loggedLines().some((line) => line.includes("no SSE transport")),
    ).toBe(false);
  });

  describe("awaitStreamingTransport", () => {
    const probe = (waitMs: number) =>
      service.awaitStreamingTransport("conversation-1", waitMs);

    it("returns immediately with waitMs 0", async () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });

      const startedAt = Date.now();
      const readiness = await probe(0);

      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toBe("no-session-id");
      expect(Date.now() - startedAt).toBeLessThan(150);
    });

    it("waits for a transport that appears during the window", async () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });

      // The client re-registers about a second after submitting results; model
      // that by making the transport appear part-way through the wait.
      let transportUp = false;
      service.streamingSessionManager.getSessionId = jest.fn(() =>
        transportUp ? "sse-late" : null,
      );
      service.streamingSessionManager.getSession = jest.fn(async () => ({ id: "sse-late" }));
      service.streamingTransportManager.hasTransport = jest.fn(() => transportUp);
      setTimeout(() => {
        transportUp = true;
      }, 120);

      const readiness = await probe(2_000);

      expect(readiness.ready).toBe(true);
      expect(readiness.reason).toBe("ready");
      expect(readiness.sseSessionId).toBe("sse-late");
      expect(readiness.waitedMs).toBeGreaterThanOrEqual(100);
    });

    it("gives up at the deadline and reports the last reason", async () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });

      const startedAt = Date.now();
      const readiness = await probe(250);
      const elapsed = Date.now() - startedAt;

      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toBe("no-session-id");
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(1_000);
    });

    it("treats a probe failure as not-ready rather than failing the turn", async () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });
      service.streamingSessionManager.getSessionId = jest.fn(() => "sse-1");
      service.streamingSessionManager.getSession = jest.fn(async () => {
        throw new Error("Redis service not available");
      });

      const readiness = await probe(0);

      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toBe("probe-error");
      expect(readiness.error).toContain("Redis service not available");
    });
  });

  describe("continuationTransportWaitMs", () => {
    it("defaults to a window comfortably above the client's reconnect (~1.1s)", () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });
      delete process.env.REACTOR_CONTINUATION_TRANSPORT_WAIT_MS;

      expect(service.continuationTransportWaitMs()).toBe(5_000);
    });

    it("honours an explicit override", () => {
      build({ role: "tool", continueAfterTools: true, transport: noTransport });
      process.env.REACTOR_CONTINUATION_TRANSPORT_WAIT_MS = "250";

      expect(service.continuationTransportWaitMs()).toBe(250);
    });
  });
});
