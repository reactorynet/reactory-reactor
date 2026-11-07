import { Response } from 'express';
import { SSETransport } from '../StreamingTransport';
import { StreamingEventLog } from '../StreamingEventLog';
import { StreamingTransportManager } from '../StreamingTransportManager';
import { StreamingEvent } from '../types/streaming.types';

/**
 * Regression tests for the server half of REACTORY-302016408/20261107/3216227283.
 *
 * Every assertion here is written against behaviour that did not exist before
 * this change, so each one fails against the old code:
 *
 * - the old keepalive wrote only `: heartbeat` (a comment EventSource discards),
 *   so the "named frame" assertions fail on it;
 * - the old `sendEvent` wrote no `id:` at all, so the id and replay assertions
 *   have nothing to find;
 * - the old code had no eviction concept, so the "resync instead of a silent
 *   gap" assertions fail rather than silently passing.
 */

interface Harness {
  res: Response;
  transport: SSETransport;
  frames: () => string[];
}

const mockResponse = () => ({
  writeHead: jest.fn().mockReturnThis(),
  write: jest.fn().mockReturnThis(),
  end: jest.fn().mockReturnThis(),
  setHeader: jest.fn().mockReturnThis(),
  flushHeaders: jest.fn().mockReturnThis(),
  cork: jest.fn().mockReturnThis(),
  uncork: jest.fn().mockReturnThis(),
  on: jest.fn().mockReturnThis(),
  off: jest.fn().mockReturnThis(),
  once: jest.fn().mockReturnThis(),
  headersSent: false,
  finished: false,
} as unknown as Response);

const framesOf = (res: Response): string[] =>
  (res.write as jest.Mock).mock.calls.map((call) => String(call[0]));

const makeEvent = (content: string, type: 'token' | 'complete' = 'token'): StreamingEvent => ({
  type,
  sessionId: 'sse-1',
  conversationId: 'chat-1',
  messageId: 'msg-1',
  timestamp: new Date('2024-01-01T00:00:00Z'),
  data: { content, delta: content, position: 0, isComplete: type === 'complete' },
} as StreamingEvent);

const createTransport = (
  options: ConstructorParameters<typeof SSETransport>[1] = {},
): Harness => {
  const res = mockResponse();
  const transport = new SSETransport(res, options);
  return { res, transport, frames: () => framesOf(res) };
};

/** Frames written after the retry/connected preamble. */
const eventFrames = (frames: string[]): string[] =>
  frames.filter((frame) => frame.startsWith('id: ') || frame.startsWith('event: resync'));

describe('SSETransport keepalive (P1)', () => {
  it('writes a named heartbeat frame in addition to the proxy-facing comment', async () => {
    const { res, transport, frames } = createTransport({ sessionKey: 'chat-1' });
    await transport.initialize();

    transport.sendHeartbeat();

    const heartbeatFrames = frames().filter((frame) => frame.includes('heartbeat'));
    expect(heartbeatFrames).toHaveLength(1);
    // Both halves, in one write: the comment is what a proxy counts, the named
    // frame is what a browser can actually observe.
    expect(heartbeatFrames[0]).toMatch(/^: heartbeat\n\nevent: heartbeat\ndata: \{"ts":\d+\}\n\n$/);
    expect(res.write).toHaveBeenCalled();
  });

  it('gives the heartbeat no id, so it cannot move the client Last-Event-ID', async () => {
    const { transport, frames } = createTransport({ sessionKey: 'chat-1' });
    await transport.initialize();

    transport.sendHeartbeat();

    const heartbeat = frames().find((frame) => frame.includes('event: heartbeat'));
    expect(heartbeat).toBeDefined();
    expect(heartbeat).not.toMatch(/(^|\n)id: /);
  });

  it('delivers a named heartbeat to an idle stream at the configured cadence', async () => {
    jest.useFakeTimers();
    try {
      (StreamingTransportManager as any).instance = undefined;
      const manager = new StreamingTransportManager({}, mockContext);
      (manager as any).sessionManager = mockSessionManager;

      const { res, transport } = createTransport({
        sessionKey: 'chat-idle',
        eventLog: manager.getEventLog(),
      });

      await manager.registerTransport({ sessionId: 'sse-idle', chatSessionId: 'chat-idle', transport });

      jest.advanceTimersByTime(26_000);

      const frames = framesOf(res);
      expect(frames.some((frame) => frame.includes('event: heartbeat'))).toBe(true);
      // The comment has to stay: it is what keeps an idle proxy from reaping
      // the socket, and it was the only half that existed before.
      expect(frames.some((frame) => frame.startsWith(': heartbeat'))).toBe(true);

      await manager.closeAllTransports();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SSETransport event ids and retry hint (P2)', () => {
  it('advertises a retry hint on connect', async () => {
    const { transport, frames } = createTransport({ sessionKey: 'chat-1', retryMs: 2500 });
    await transport.initialize();

    expect(frames()[0]).toMatch(/^retry: 2500\n\n/);
  });

  it('emits a monotonic id on every event', async () => {
    const { transport, frames } = createTransport({ sessionKey: 'chat-1' });
    await transport.initialize();

    await transport.sendEvent(makeEvent('a'));
    await transport.sendEvent(makeEvent('b'));
    await transport.sendEvent(makeEvent('c'));

    expect(eventFrames(frames()).map((frame) => frame.split('\n')[0])).toEqual([
      'id: 1',
      'id: 2',
      'id: 3',
    ]);
  });

  it('continues the same id sequence across a reconnect on the same session', async () => {
    const log = new StreamingEventLog();
    const first = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await first.transport.initialize();
    await first.transport.sendEvent(makeEvent('a'));
    await first.transport.sendEvent(makeEvent('b'));
    await first.transport.close();

    const second = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await second.transport.initialize();
    await second.transport.sendEvent(makeEvent('c'));

    expect(eventFrames(second.frames())).toHaveLength(1);
    expect(second.frames().find((frame) => frame.startsWith('id: '))).toMatch(/^id: 3\n/);
  });

  it('numbers per session, not per transport, when the manager allocates the id', async () => {
    (StreamingTransportManager as any).instance = undefined;
    const manager = new StreamingTransportManager({}, mockContext);
    (manager as any).sessionManager = mockSessionManager;

    const { res, transport } = createTransport({
      sessionKey: 'chat-ids',
      eventLog: manager.getEventLog(),
    });
    await manager.registerTransport({ sessionId: 'sse-ids', chatSessionId: 'chat-ids', transport });

    await manager.sendEventToSession('chat-ids', makeEvent('a'));
    await manager.sendEventToSession('chat-ids', makeEvent('b'));

    expect(eventFrames(framesOf(res)).map((frame) => frame.split('\n')[0])).toEqual(['id: 1', 'id: 2']);
    await manager.closeAllTransports();
  });
});

describe('SSETransport Last-Event-ID replay (P2)', () => {
  it('replays the events after Last-Event-ID, in order, before live delivery', async () => {
    const log = new StreamingEventLog();
    const first = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await first.transport.initialize();
    await first.transport.sendEvent(makeEvent('a'));
    await first.transport.sendEvent(makeEvent('b'));
    await first.transport.sendEvent(makeEvent('c'));
    await first.transport.close();

    const second = createTransport({ sessionKey: 'chat-1', eventLog: log, lastEventId: 1 });
    await second.transport.initialize();
    await second.transport.sendEvent(makeEvent('d'));

    expect(second.transport.replayOutcome?.status).toBe('replayed');
    expect(second.transport.replayOutcome?.replayed).toBe(2);

    const replayed = eventFrames(second.frames());
    expect(replayed.map((frame) => frame.split('\n')[0])).toEqual(['id: 2', 'id: 3', 'id: 4']);
    expect(replayed[0]).toContain('"content":"b"');
    expect(replayed[1]).toContain('"content":"c"');
    expect(replayed[2]).toContain('"content":"d"');
  });

  it('replays nothing when the client is already at the newest id', async () => {
    const log = new StreamingEventLog();
    const first = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await first.transport.initialize();
    await first.transport.sendEvent(makeEvent('a'));
    await first.transport.close();

    const second = createTransport({ sessionKey: 'chat-1', eventLog: log, lastEventId: 1 });
    await second.transport.initialize();

    expect(second.transport.replayOutcome?.status).toBe('current');
    expect(eventFrames(second.frames())).toEqual([]);
  });

  it('treats a connection without Last-Event-ID as a first connection', async () => {
    const log = new StreamingEventLog();
    const first = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await first.transport.initialize();
    await first.transport.sendEvent(makeEvent('a'));
    await first.transport.close();

    const second = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await second.transport.initialize();

    expect(second.transport.replayOutcome?.status).toBe('none');
    expect(eventFrames(second.frames())).toEqual([]);
  });

  it('sends an explicit resync when the requested id has been evicted', async () => {
    const log = new StreamingEventLog({ maxEventsPerStream: 2 });
    const first = createTransport({ sessionKey: 'chat-1', eventLog: log });
    await first.transport.initialize();
    for (const content of ['a', 'b', 'c', 'd']) {
      await first.transport.sendEvent(makeEvent(content));
    }
    await first.transport.close();

    // Ids 1 and 2 are gone; asking from id 1 must not resume silently at 3.
    const second = createTransport({ sessionKey: 'chat-1', eventLog: log, lastEventId: 1 });
    await second.transport.initialize();

    expect(second.transport.replayOutcome?.status).toBe('resync');
    expect(second.transport.replayOutcome?.reason).toBe('evicted');

    const resyncFrames = second.frames().filter((frame) => frame.startsWith('event: resync'));
    expect(resyncFrames).toHaveLength(1);
    const payload = JSON.parse(resyncFrames[0].split('data: ')[1].trim());
    expect(payload).toMatchObject({ reason: 'evicted', lastEventId: 1, oldestEventId: 3, latestEventId: 4 });
    // A resync is a control frame: it must not move the client's cursor.
    expect(resyncFrames[0]).not.toMatch(/(^|\n)id: /);
  });

  it('sends an explicit resync when this process has no history for the session', async () => {
    const log = new StreamingEventLog();
    const transport = createTransport({ sessionKey: 'chat-unknown', eventLog: log, lastEventId: 42 });
    await transport.transport.initialize();

    expect(transport.transport.replayOutcome?.status).toBe('resync');
    expect(transport.transport.replayOutcome?.reason).toBe('unknown');
    expect(transport.frames().some((frame) => frame.startsWith('event: resync'))).toBe(true);
  });
});

describe('StreamingEventLog bounds (P2)', () => {
  it('evicts the oldest entries once the count bound is reached', () => {
    const log = new StreamingEventLog({ maxEventsPerStream: 3 });
    for (const content of ['a', 'b', 'c', 'd', 'e']) {
      log.append('chat-1', makeEvent(content));
    }

    expect(log.size('chat-1')).toBe(3);
    expect(log.latestId('chat-1')).toBe(5);

    // Ids 1 and 2 were evicted, so a resume from 1 is a gap (the entry that
    // should follow 1 is gone). It must be reported, never silently skipped.
    const evicted = log.since('chat-1', 1);
    expect(evicted.outcome.status).toBe('resync');
    expect(evicted.outcome.reason).toBe('evicted');
    expect(evicted.outcome.oldestAvailableId).toBe(3);
    expect(evicted.entries).toEqual([]);

    // A resume from 2 is still contiguous: retained entry 3 follows it directly.
    const contiguous = log.since('chat-1', 2);
    expect(contiguous.outcome.status).toBe('replayed');
    expect(contiguous.entries.map((entry) => entry.id)).toEqual([3, 4, 5]);

    const stillRetained = log.since('chat-1', 3);
    expect(stillRetained.outcome.status).toBe('replayed');
    expect(stillRetained.entries.map((entry) => entry.id)).toEqual([4, 5]);
  });

  it('keeps memory flat under sustained load', () => {
    const log = new StreamingEventLog({ maxEventsPerStream: 100 });
    for (let i = 0; i < 5_000; i++) {
      log.append('chat-1', makeEvent(`token-${i}`));
    }

    expect(log.size('chat-1')).toBe(100);
    expect(log.latestId('chat-1')).toBe(5_000);
  });

  it('drops entries older than the retention window, and says so on resume', () => {
    const log = new StreamingEventLog({ maxEventsPerStream: 1_000, maxAgeMs: 1_000 });
    const start = 1_000_000;
    log.append('chat-1', makeEvent('a'), start);
    log.append('chat-1', makeEvent('b'), start + 10);

    // Ten seconds later both entries are stale; the ids still exist though, so
    // resuming from id 1 is a gap rather than a silent "nothing new".
    const stale = log.since('chat-1', 1, start + 10_000);
    expect(stale.outcome.status).toBe('resync');
    expect(stale.outcome.reason).toBe('evicted');
    expect(log.size('chat-1')).toBe(0);
  });

  it('forgets a stream that has been idle for a full retention window', () => {
    const log = new StreamingEventLog({ maxEventsPerStream: 10, maxAgeMs: 1_000 });
    const start = 1_000_000;
    log.append('chat-old', makeEvent('a'), start);
    // A later append on any stream sweeps the map; one per window, not per event.
    log.append('chat-new', makeEvent('b'), start + 5_000);

    expect(log.size('chat-old')).toBe(0);
    // The key is gone rather than holding a pruned shell, so a resume against
    // it is reported as unknown instead of appearing continuously served.
    expect(log.since('chat-old', 1, start + 5_000).outcome.reason).toBe('unknown');
  });

  it('ignores an unusable Last-Event-ID instead of inventing a position', () => {
    const log = new StreamingEventLog();
    log.append('chat-1', makeEvent('a'));

    expect(log.since('chat-1', undefined).outcome.status).toBe('none');
    expect(log.since('chat-1', 0).outcome.status).toBe('none');
    expect(log.since('chat-1', -3).outcome.status).toBe('none');
  });

  it('reports resync when the client claims an id this process never issued', () => {
    const log = new StreamingEventLog();
    log.append('chat-1', makeEvent('a'));

    const slice = log.since('chat-1', 99);
    expect(slice.outcome.status).toBe('resync');
    expect(slice.outcome.reason).toBe('unknown');
  });
});

describe('StreamingTransportManager reconnect handling (P2)', () => {
  beforeEach(() => {
    (StreamingTransportManager as any).instance = undefined;
    delete process.env.REACTORY_STREAMING_FANOUT;
  });

  it('replays instead of re-flushing the buffer, so a reconnected client sees no duplicate', async () => {
    const manager = new StreamingTransportManager({}, mockContext as any);
    (manager as any).sessionManager = mockSessionManager;

    const first = createTransport({ sessionKey: 'chat-1', eventLog: manager.getEventLog() });
    await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport: first.transport });

    // Delivered live as id 1.
    await manager.sendEventToSession('chat-1', makeEvent('a'));

    // Transport dies; the next event has nowhere to go and is buffered.
    await first.transport.close();
    await manager.sendEventToSession('chat-1', makeEvent('b'));

    expect((manager as any).eventBuffer.has('chat-1')).toBe(true);

    // The client reconnects having seen id 1 only.
    const second = createTransport({
      sessionKey: 'chat-1',
      eventLog: manager.getEventLog(),
      lastEventId: 1,
    });
    await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: 'chat-1', transport: second.transport });

    const replayed = eventFrames(second.frames());
    expect(second.transport.replayOutcome?.status).toBe('replayed');
    expect(replayed.map((frame) => frame.split('\n')[0])).toEqual(['id: 2']);
    // Exactly once: the buffer was superseded by the replay rather than flushed
    // on top of it.
    expect(replayed.filter((frame) => frame.startsWith('id: 2'))).toHaveLength(1);
    expect((manager as any).eventBuffer.has('chat-1')).toBe(false);

    // Live delivery continues from the same numbering.
    await manager.sendEventToSession('chat-1', makeEvent('c'));
    expect(eventFrames(second.frames()).map((frame) => frame.split('\n')[0])).toEqual(['id: 2', 'id: 3']);

    await manager.closeAllTransports();
  });

  it('still flushes the buffer for a client that reconnects without Last-Event-ID', async () => {
    const manager = new StreamingTransportManager({}, mockContext as any);
    (manager as any).sessionManager = mockSessionManager;

    const first = createTransport({ sessionKey: 'chat-1', eventLog: manager.getEventLog() });
    await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport: first.transport });
    await first.transport.close();

    await manager.sendEventToSession('chat-1', makeEvent('a'));

    const second = createTransport({ sessionKey: 'chat-1', eventLog: manager.getEventLog() });
    await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: 'chat-1', transport: second.transport });

    expect(second.transport.replayOutcome?.status).toBe('none');
    expect(eventFrames(second.frames()).map((frame) => frame.split('\n')[0])).toEqual(['id: 1']);
    expect((manager as any).eventBuffer.has('chat-1')).toBe(false);

    await manager.closeAllTransports();
  });

  it('does not interleave keepalives into an active stream, even from the per-turn heartbeat', async () => {
    const manager = new StreamingTransportManager({}, mockContext as any);
    (manager as any).sessionManager = mockSessionManager;

    const { res, transport } = createTransport({
      sessionKey: 'chat-1',
      eventLog: manager.getEventLog(),
    });
    const heartbeatSpy = jest.spyOn(transport, 'sendHeartbeat');
    await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport });

    // Traffic just before the per-turn tick: the stream is demonstrably alive.
    await manager.sendEventToSession('chat-1', makeEvent('a'));
    manager.sendHeartbeatToSession('chat-1');

    expect(heartbeatSpy).not.toHaveBeenCalled();
    expect(framesOf(res).some((frame) => frame.includes('event: heartbeat'))).toBe(false);

    await manager.closeAllTransports();
  });
});

const mockContext = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockSessionManager = {
  getSession: jest.fn(),
  updateSession: jest.fn(),
} as any;
