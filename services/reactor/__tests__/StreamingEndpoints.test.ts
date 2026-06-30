import request from 'supertest';
import express from 'express';
import { StreamingEndpoints } from '../StreamingEndpoints';
import { StreamingSession, StreamingEvent } from '../types/streaming.types';

const mockTransportManager = {
  registerTransport: jest.fn(),
  sendEventToSession: jest.fn(),
  closeTransport: jest.fn(),
  hasTransport: jest.fn(),
  getTransportCount: jest.fn(),
  closeAllTransports: jest.fn(),
  cleanupDisconnectedTransports: jest.fn(),
} as any;

const mockSessionManager = {
  getSession: jest.fn(),
  updateSession: jest.fn(),
  cleanupExpiredSessions: jest.fn(),
} as any;

const mockContext = {
  getService: (id: string) => {
    if (id === 'reactor.StreamingTransportManager@1.0.0') return mockTransportManager;
    if (id === 'reactor.StreamingSessionManager@1.0.0') return mockSessionManager;
    return undefined;
  },
  user: { _id: 'test-user-789' },
  partner: { key: 'test-partner' },
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockSession: StreamingSession = {
  sessionId: 'test-session-123',
  conversationId: 'test-conversation-456',
  userId: 'test-user-789',
  transport: 'sse',
  status: 'active',
  createdAt: new Date('2024-01-01T00:00:00Z'),
  lastActivity: new Date('2024-01-01T00:00:00Z'),
  expiresAt: new Date('2024-01-01T01:00:00Z'),
  capabilities: {
    supportsTokenStreaming: true,
    supportsToolStreaming: false,
  },
};

describe('StreamingEndpoints', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = mockContext;
      next();
    });
    StreamingEndpoints.setupRoutes(app);
    jest.clearAllMocks();
  });

  describe('GET /reactor-chat/streaming/sse/:sessionId', () => {
    it('should return 404 for a non-existent session', async () => {
      mockSessionManager.getSession.mockResolvedValue(null);

      await request(app)
        .get('/reactor-chat/streaming/sse/unknown-session')
        .expect(404)
        .expect({
          error: 'Session not found',
          sessionId: 'unknown-session',
        });

      expect(mockTransportManager.registerTransport).not.toHaveBeenCalled();
    });

    it('should return 400 for an inactive session', async () => {
      mockSessionManager.getSession.mockResolvedValue({ ...mockSession, status: 'completed' });

      await request(app)
        .get('/reactor-chat/streaming/sse/test-session-123')
        .expect(400)
        .expect({
          error: 'Session is not active',
          sessionId: 'test-session-123',
          status: 'completed',
        });
    });

    it('should register the transport for a valid active session', async () => {
      mockSessionManager.getSession.mockResolvedValue(mockSession);
      mockTransportManager.registerTransport.mockImplementation(async (args: any) => {
        await args.transport.initialize();
        await args.transport.close();
      });

      const response = await request(app)
        .get('/reactor-chat/streaming/sse/test-session-123')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(mockSessionManager.getSession).toHaveBeenCalledWith('test-session-123');
      expect(mockTransportManager.registerTransport).toHaveBeenCalledWith({
        sessionId: mockSession.sessionId,
        chatSessionId: mockSession.conversationId,
        transport: expect.any(Object),
      });
    });

    it('should return a 200 SSE response when transport registration fails after headers are flushed', async () => {
      mockSessionManager.getSession.mockResolvedValue(mockSession);
      mockTransportManager.registerTransport.mockImplementation(async (args: any) => {
        await args.transport.initialize();
        throw new Error('Transport registration failed');
      });

      const response = await request(app)
        .get('/reactor-chat/streaming/sse/test-session-123')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });

    it('should return 500 on session manager errors', async () => {
      mockSessionManager.getSession.mockRejectedValue(
        new Error('Session database connection failed'),
      );

      await request(app)
        .get('/reactor-chat/streaming/sse/test-session-123')
        .expect(500)
        .expect({
          error: 'Failed to retrieve session',
          details: 'Session database connection failed',
        });
    });
  });

  describe('POST /reactor-chat/streaming/events/:sessionId', () => {
    const mockEvent: StreamingEvent = {
      type: 'token',
      sessionId: 'test-session-123',
      conversationId: 'test-conversation-456',
      messageId: 'msg-1',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      data: { content: 'Hello', delta: 'Hello', position: 0, isComplete: false },
    };

    it('should send an event to the session transport', async () => {
      mockTransportManager.hasTransport.mockReturnValue(true);
      mockTransportManager.sendEventToSession.mockResolvedValue(undefined);

      await request(app)
        .post('/reactor-chat/streaming/events/test-session-123')
        .send(mockEvent)
        .expect(200)
        .expect({ status: 'sent' });

      expect(mockTransportManager.sendEventToSession).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({ type: 'token', conversationId: 'test-conversation-456' }),
      );
    });

    it('should return 404 when no transport is registered', async () => {
      mockTransportManager.hasTransport.mockReturnValue(false);

      await request(app)
        .post('/reactor-chat/streaming/events/test-session-123')
        .send(mockEvent)
        .expect(404)
        .expect({
          error: 'No transport registered for session',
          sessionId: 'test-session-123',
        });
    });

    it('should return 400 for an invalid event type', async () => {
      await request(app)
        .post('/reactor-chat/streaming/events/test-session-123')
        .send({ type: 'invalid_type', conversationId: 'test-conversation-456' })
        .expect(400);
    });

    it('should return 500 on transport send failure', async () => {
      mockTransportManager.hasTransport.mockReturnValue(true);
      mockTransportManager.sendEventToSession.mockRejectedValue(
        new Error('Transport send failed'),
      );

      await request(app)
        .post('/reactor-chat/streaming/events/test-session-123')
        .send(mockEvent)
        .expect(500)
        .expect({
          error: 'Failed to send event',
          details: 'Transport send failed',
        });
    });
  });

  describe('GET /reactor-chat/streaming/session/:sessionId/status', () => {
    it('should return session status with transport info', async () => {
      mockSessionManager.getSession.mockResolvedValue(mockSession);
      mockTransportManager.hasTransport.mockReturnValue(true);

      await request(app)
        .get('/reactor-chat/streaming/session/test-session-123/status')
        .expect(200)
        .expect({
          sessionId: 'test-session-123',
          status: 'active',
          hasTransport: true,
          lastActivity: '2024-01-01T00:00:00.000Z',
          expiresAt: '2024-01-01T01:00:00.000Z',
        });
    });

    it('should return 404 for a non-existent session', async () => {
      mockSessionManager.getSession.mockResolvedValue(null);

      await request(app)
        .get('/reactor-chat/streaming/session/unknown-session/status')
        .expect(404)
        .expect({
          error: 'Session not found',
          sessionId: 'unknown-session',
        });
    });
  });

  describe('DELETE /reactor-chat/streaming/session/:sessionId', () => {
    it('should close the session transport', async () => {
      mockTransportManager.closeTransport.mockResolvedValue(undefined);

      await request(app)
        .delete('/reactor-chat/streaming/session/test-session-123')
        .expect(200)
        .expect({ status: 'closed', sessionId: 'test-session-123' });

      expect(mockTransportManager.closeTransport).toHaveBeenCalledWith('test-session-123');
    });

    it('should handle close errors gracefully', async () => {
      mockTransportManager.closeTransport.mockRejectedValue(
        new Error('Transport close failed'),
      );

      await request(app)
        .delete('/reactor-chat/streaming/session/test-session-123')
        .expect(200)
        .expect({
          status: 'closed',
          sessionId: 'test-session-123',
          warning: 'Transport close failed',
        });
    });
  });

  describe('GET /reactor-chat/streaming/health', () => {
    it('should return health status', async () => {
      mockTransportManager.getTransportCount.mockReturnValue(5);

      const response = await request(app)
        .get('/reactor-chat/streaming/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'healthy',
        activeTransports: 5,
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
    });
  });

  describe('GET /reactor-chat/streaming/stats', () => {
    it('should return streaming statistics', async () => {
      mockTransportManager.getTransportCount.mockReturnValue(3);
      mockSessionManager.cleanupExpiredSessions.mockResolvedValue(2);

      const response = await request(app)
        .get('/reactor-chat/streaming/stats')
        .expect(200);

      expect(response.body).toEqual({
        activeTransports: 3,
        expiredSessions: 2,
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
    });
  });
});
