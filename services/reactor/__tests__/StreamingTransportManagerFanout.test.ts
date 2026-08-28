import { StreamingTransportManager } from '../StreamingTransportManager';
import { StreamingSessionManager } from '../StreamingSessionManager';
import { StreamingTransport } from '../StreamingTransport';
import { StreamingEvent } from '../types/streaming.types';

const mockContext = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockSessionManager = {
  getSession: jest.fn(),
  updateSession: jest.fn(),
} as unknown as jest.Mocked<StreamingSessionManager>;

const createMockTransport = (isConnected = true): jest.Mocked<StreamingTransport> => ({
  isConnected,
  initialize: jest.fn().mockResolvedValue(undefined),
  sendEvent: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
} as jest.Mocked<StreamingTransport>);

const SSE_ID = 'sse-session-123';
const CHAT_ID = 'chat-session-456';
const CHANNEL = `reactory:streaming:events:${CHAT_ID}`;

const makeEvent = (type: string = 'token'): StreamingEvent => ({
  type: type as StreamingEvent['type'],
  sessionId: SSE_ID,
  conversationId: CHAT_ID,
  messageId: 'msg-1',
  timestamp: new Date('2024-01-01T00:00:00Z'),
  data: { content: 'Hello', delta: 'Hello', position: 0, isComplete: false },
});

/**
 * Stands in for the duplicated ioredis subscriber connection: records what was
 * subscribed and lets a test inject a message as if another process published.
 */
class FakeSubscriber {
  channels = new Set<string>();
  handlers: Record<string, Array<(...args: any[]) => void>> = {};
  disconnected = false;

  on(evt: string, cb: (...args: any[]) => void) {
    (this.handlers[evt] = this.handlers[evt] || []).push(cb);
    return this;
  }
  async subscribe(...channels: string[]) { channels.forEach((c) => this.channels.add(c)); return channels.length; }
  async unsubscribe(...channels: string[]) { channels.forEach((c) => this.channels.delete(c)); return channels.length; }
  disconnect() { this.disconnected = true; }

  /** Simulate a publish arriving from another process. */
  emit(channel: string, payload: string) {
    (this.handlers.message || []).forEach((cb) => cb(channel, payload));
  }
}

describe('StreamingTransportManager cross-process fanout', () => {
  let manager: StreamingTransportManager;
  let transport: jest.Mocked<StreamingTransport>;
  let subscriber: FakeSubscriber;
  let publish: jest.Mock;

  beforeEach(() => {
    delete process.env.REACTORY_STREAMING_FANOUT;
    (StreamingTransportManager as any).instance = undefined;
    manager = new StreamingTransportManager({}, mockContext);
    (manager as any).sessionManager = mockSessionManager;
    transport = createMockTransport();

    subscriber = new FakeSubscriber();
    publish = jest.fn().mockResolvedValue(0);
    const redisService: any = {
      getClient: () => ({ duplicate: () => subscriber, publish }),
    };
    jest.clearAllMocks();
    (manager as any).setRedisService(redisService);
  });

  it('subscribes to a conversation on its first local transport and unsubscribes on its last', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    expect(Array.from(subscriber.channels)).toEqual([CHANNEL]);

    // A second transport on the same conversation must not re-subscribe.
    await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: CHAT_ID, transport: createMockTransport() });
    expect(Array.from(subscriber.channels)).toEqual([CHANNEL]);

    await manager.closeTransport(SSE_ID);
    expect(subscriber.channels.has(CHANNEL)).toBe(true); // one still held
    await manager.closeTransport('sse-2');
    expect(subscriber.channels.has(CHANNEL)).toBe(false);
  });

  it('publishes every event so other processes can deliver it', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    await manager.sendEventToSession(CHAT_ID, makeEvent());

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = publish.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    const envelope = JSON.parse(payload);
    expect(envelope.chatSessionId).toBe(CHAT_ID);
    expect(envelope.event.type).toBe('token');
    expect(typeof envelope.origin).toBe('string');
  });

  /**
   * The whole point: the turn runs on a process holding no transport, and the
   * event still has to reach the process that does.
   */
  it('delivers an event published by another process to local transports', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    transport.sendEvent.mockClear();

    subscriber.emit(CHANNEL, JSON.stringify({
      origin: 'some-other-process',
      chatSessionId: CHAT_ID,
      event: makeEvent('complete'),
    }));
    await new Promise((r) => setImmediate(r));

    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
    const delivered = transport.sendEvent.mock.calls[0][0];
    expect(delivered.type).toBe('complete');
    // The Date survives the JSON round-trip as a Date, not a string.
    expect(delivered.timestamp).toBeInstanceOf(Date);
  });

  it('ignores its own publish so the event is not delivered twice', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    await manager.sendEventToSession(CHAT_ID, makeEvent());
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);

    // Echo our own envelope back, as Redis does to every subscriber.
    const [, payload] = publish.mock.calls[0];
    subscriber.emit(CHANNEL, payload);
    await new Promise((r) => setImmediate(r));

    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
  });

  /**
   * This runs once per streamed token on the provider's own loop. Awaiting a
   * Redis round-trip per token would put network latency in series with
   * generation, which is exactly the bottleneck a slow local model exposes.
   */
  it('does not wait on the publish when the event was delivered locally', async () => {
    let settled = false;
    publish.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    await manager.sendEventToSession(CHAT_ID, makeEvent()).then(() => { settled = true; });

    expect(settled).toBe(true);
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1); // dispatched, just not awaited
  });

  it('still waits on the publish when nothing was delivered locally', async () => {
    // Here the count decides whether the event needs buffering, so it matters.
    publish.mockResolvedValue(2);
    await expect(manager.sendEventToSession(CHAT_ID, makeEvent())).resolves.toBeUndefined();

    const t = createMockTransport();
    await manager.registerTransport({ sessionId: 'sse-late', chatSessionId: CHAT_ID, transport: t });
    expect(t.sendEvent).not.toHaveBeenCalled(); // remote handled it, nothing buffered
  });

  it('does not buffer when a remote process received the event', async () => {
    publish.mockResolvedValue(1); // one remote subscriber, none local
    await manager.sendEventToSession(CHAT_ID, makeEvent());

    // Nothing held: a later reconnect must not replay what was already delivered.
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    expect(transport.sendEvent).not.toHaveBeenCalled();
  });

  it('buffers when no process anywhere holds a transport', async () => {
    publish.mockResolvedValue(0);
    await manager.sendEventToSession(CHAT_ID, makeEvent());

    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('discounts its own subscription when judging remote delivery', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    transport.isConnected = false;      // local transport is dead
    publish.mockResolvedValue(1);       // the only subscriber is us

    await manager.sendEventToSession(CHAT_ID, makeEvent());

    // receivers(1) - self(1) = 0 remote, so it must be buffered.
    const fresh = createMockTransport();
    await manager.registerTransport({ sessionId: 'sse-3', chatSessionId: CHAT_ID, transport: fresh });
    expect(fresh.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('falls back to local-only delivery when fanout is disabled', async () => {
    process.env.REACTORY_STREAMING_FANOUT = 'off';
    (StreamingTransportManager as any).instance = undefined;
    const local = new StreamingTransportManager({}, mockContext);
    (local as any).sessionManager = mockSessionManager;
    (local as any).setRedisService({ getClient: () => ({ duplicate: () => subscriber, publish }) });

    const t = createMockTransport();
    await local.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport: t });
    await local.sendEventToSession(CHAT_ID, makeEvent());

    expect(t.sendEvent).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(subscriber.channels.size).toBe(0);
  });

  it('works with no Redis service at all', async () => {
    (StreamingTransportManager as any).instance = undefined;
    const bare = new StreamingTransportManager({}, mockContext);
    (bare as any).sessionManager = mockSessionManager;

    const t = createMockTransport();
    await bare.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport: t });
    await expect(bare.sendEventToSession(CHAT_ID, makeEvent())).resolves.toBeUndefined();
    expect(t.sendEvent).toHaveBeenCalledTimes(1);
  });
});

describe('StreamingTransportManager keepalive', () => {
  let manager: StreamingTransportManager;
  let transport: any;

  beforeEach(() => {
    jest.useFakeTimers();
    (StreamingTransportManager as any).instance = undefined;
    manager = new StreamingTransportManager({}, mockContext);
    (manager as any).sessionManager = mockSessionManager;
    transport = { ...createMockTransport(), sendHeartbeat: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * ingress-nginx closes a connection it has seen no traffic on after 60s by
   * default, so an idle stream has to be written to before then.
   */
  it('writes a keepalive to an idle stream', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });

    jest.advanceTimersByTime(26_000);
    expect(transport.sendHeartbeat).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(26_000);
    expect(transport.sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('does not interleave keepalives into an active stream', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });

    // Traffic just before the sweep — the stream is demonstrably alive.
    jest.advanceTimersByTime(24_000);
    await manager.sendEventToSession(CHAT_ID, makeEvent());
    jest.advanceTimersByTime(2_000);

    expect(transport.sendHeartbeat).not.toHaveBeenCalled();
  });

  it('stops sweeping once the last transport is gone', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    await manager.closeTransport(SSE_ID);

    jest.advanceTimersByTime(60_000);
    expect(transport.sendHeartbeat).not.toHaveBeenCalled();
    expect((manager as any).heartbeatTimer).toBeNull();
  });

  it('skips a disconnected transport', async () => {
    await manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport });
    transport.isConnected = false;

    jest.advanceTimersByTime(26_000);
    expect(transport.sendHeartbeat).not.toHaveBeenCalled();
  });
});

describe('StreamingTransportManager logging safety', () => {
  /**
   * A log call must never be the reason a request fails. `slog` is reached from
   * catch blocks and from the event-delivery path, so a level the context does
   * not implement used to throw straight out of sendEventToSession and fail the
   * chat turn — reporting the logging call as the cause and hiding the real one.
   */
  it('does not throw when the context lacks the requested level', async () => {
    (StreamingTransportManager as any).instance = undefined;
    const partialContext = { error: jest.fn() } as any; // no debug/info/warn
    const manager = new StreamingTransportManager({}, partialContext);
    (manager as any).sessionManager = mockSessionManager;

    const transport = createMockTransport();
    await expect(
      manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport }),
    ).resolves.toBeUndefined();

    await expect(manager.sendEventToSession(CHAT_ID, makeEvent())).resolves.toBeUndefined();
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
    expect(partialContext.error).toHaveBeenCalled(); // fell back rather than threw
  });

  it('does not throw when the context has no logging methods at all', async () => {
    (StreamingTransportManager as any).instance = undefined;
    const manager = new StreamingTransportManager({}, {} as any);
    (manager as any).sessionManager = mockSessionManager;

    const transport = createMockTransport();
    await expect(
      manager.registerTransport({ sessionId: SSE_ID, chatSessionId: CHAT_ID, transport }),
    ).resolves.toBeUndefined();
    await expect(manager.sendEventToSession(CHAT_ID, makeEvent())).resolves.toBeUndefined();
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
  });
});
