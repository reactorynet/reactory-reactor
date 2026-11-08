import request from 'supertest';
import express from 'express';
import { StreamingEndpoints, readLastEventId } from '../StreamingEndpoints';
import { StreamingEventLog } from '../StreamingEventLog';

/**
 * Endpoint-level coverage for the `Last-Event-ID` wiring.
 *
 * `StreamingTransportReplay.test.ts` exercises the transport and the log in
 * isolation; these tests cover the seam that connects a real HTTP request to
 * them: that the browser-set header (and the query fallback) reach the
 * transport, that the replay is written to the response body before the
 * connection is closed, and that an evicted cursor produces a `resync` frame on
 * the wire rather than a silent gap. Nothing else in the suite constructs the
 * transport through `handleSSEConnection`, so without this the wiring could be
 * deleted and every other test would still pass.
 */

const mockTransportManager: any = {
  registerTransport: jest.fn(),
  sendEventToSession: jest.fn(),
  closeTransport: jest.fn(),
  hasTransport: jest.fn(),
  getTransportCount: jest.fn(),
  closeAllTransports: jest.fn(),
  cleanupDisconnectedTransports: jest.fn(),
};

const mockSessionManager: any = {
  getSession: jest.fn(),
  updateSession: jest.fn(),
  cleanupExpiredSessions: jest.fn(),
};

const mockContext: any = {
  getService: (id: string) => {
    if (id === 'reactor.StreamingTransportManager@1.0.0') return mockTransportManager;
    if (id === 'reactor.StreamingSessionManager@1.0.0') return mockSessionManager;
    return undefined;
  },
  user: { _id: 'u' },
  partner: { key: 'p' },
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};

const mockSession: any = {
  sessionId: 'test-session-123',
  conversationId: 'test-conversation-456',
  userId: 'u',
  transport: 'sse',
  status: 'active',
  createdAt: new Date('2024-01-01T00:00:00Z'),
  lastActivity: new Date('2024-01-01T00:00:00Z'),
  expiresAt: new Date('2024-01-01T01:00:00Z'),
  capabilities: { supportsTokenStreaming: true, supportsToolStreaming: false },
};

describe('readLastEventId', () => {
  it('reads the browser-set header', () => {
    expect(readLastEventId({ headers: { 'last-event-id': '7' } } as any)).toBe(7);
  });
  it('reads the first value of an array header', () => {
    expect(readLastEventId({ headers: { 'last-event-id': ['8', '9'] } } as any)).toBe(8);
  });
  it('falls back to the query param', () => {
    expect(readLastEventId({ headers: {}, query: { 'last-event-id': '11' } } as any)).toBe(11);
  });
  it('ignores non-numeric / non-positive / absent values', () => {
    expect(readLastEventId({ headers: {} } as any)).toBeUndefined();
    expect(readLastEventId({ headers: { 'last-event-id': 'abc' } } as any)).toBeUndefined();
    expect(readLastEventId({ headers: { 'last-event-id': '0' } } as any)).toBeUndefined();
    expect(readLastEventId({ headers: { 'last-event-id': '-4' } } as any)).toBeUndefined();
    expect(readLastEventId({ headers: { 'last-event-id': '' } } as any)).toBeUndefined();
  });
});

describe('endpoint Last-Event-ID wiring', () => {
  let app: express.Application;
  const log = new StreamingEventLog();

  beforeEach(() => {
    log.clear();
    mockTransportManager.getEventLog = () => log;
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.context = mockContext; next(); });
    StreamingEndpoints.setupRoutes(app);
    jest.clearAllMocks();
    mockSessionManager.getSession.mockResolvedValue(mockSession);
  });

  afterEach(() => { delete mockTransportManager.getEventLog; });

  it('replays from the manager log using the header, before closing', async () => {
    log.append(mockSession.conversationId, { type: 'token', data: { content: 'a' } } as any);
    log.append(mockSession.conversationId, { type: 'token', data: { content: 'b' } } as any);
    log.append(mockSession.conversationId, { type: 'token', data: { content: 'c' } } as any);

    let captured: any;
    mockTransportManager.registerTransport.mockImplementation(async (args: any) => {
      captured = args.transport;
      await args.transport.initialize();
      await args.transport.close();
    });

    const response = await request(app)
      .get('/reactor-chat/streaming/sse/test-session-123')
      .set('Last-Event-ID', '1')
      .expect(200);

    expect(captured.replayOutcome).toMatchObject({
      status: 'replayed', replayed: 2, requestedLastEventId: 1,
    });
    expect(response.text).toContain('id: 2');
    expect(response.text).toContain('id: 3');
  });

  it('resyncs when the endpoint is handed an evicted id', async () => {
    const small = new StreamingEventLog({ maxEventsPerStream: 1 });
    mockTransportManager.getEventLog = () => small;
    for (const c of ['a', 'b', 'c']) small.append(mockSession.conversationId, { type: 'token', data: { content: c } } as any);

    let captured: any;
    mockTransportManager.registerTransport.mockImplementation(async (args: any) => {
      captured = args.transport;
      await args.transport.initialize();
      await args.transport.close();
    });

    const response = await request(app)
      .get('/reactor-chat/streaming/sse/test-session-123')
      .query({ 'last-event-id': '1' })
      .expect(200);

    expect(captured.replayOutcome).toMatchObject({ status: 'resync', reason: 'evicted' });
    expect(response.text).toContain('event: resync');
  });
});
