import request from 'supertest';
import express from 'express';
import { StreamingEndpoints } from '../StreamingEndpoints';
import { StreamingSessionManager } from '../StreamingSessionManager';
import { StreamingSession } from '../types/streaming.types';
import { Server } from 'http';

// Helper functions to reduce nesting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Mock dependencies
jest.mock('../StreamingTransportManager');
jest.mock('../StreamingSessionManager');

// Mock dependencies
const mockTransportManager = {
  registerTransport: jest.fn(),
  sendEventToSession: jest.fn(),
  closeTransport: jest.fn(),
  hasTransport: jest.fn(),
  getTransportCount: jest.fn(),
  closeAllTransports: jest.fn(),
  cleanupDisconnectedTransports: jest.fn(),
  updateSessionActivity: jest.fn(),
} as any;

const mockSessionManager = {
  createSession: jest.fn(),
  getSession: jest.fn(),
  updateSession: jest.fn(),
  cleanupExpiredSessions: jest.fn(),
  DEFAULT_EXPIRY_HOURS: 1,
  SESSION_KEY_PREFIX: 'streaming:session:',
  SESSION_INDEX_KEY: 'streaming:sessions',
  getSessionKey: jest.fn(),
  getTTLSeconds: jest.fn(),
} as unknown as jest.Mocked<StreamingSessionManager>;

describe('StreamingEndpoints', () => {
  let app: express.Application;
  let endpoints: StreamingEndpoints;
  let server: Server;
  
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
      supportsToolStreaming: false
    }
  };
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    endpoints = new StreamingEndpoints(mockTransportManager, mockSessionManager);
    endpoints.setupRoutes(app);
    
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    if (server) {
      server.close();
    }
    jest.clearAllMocks();
  });
  
  describe('SSE Endpoint', () => {
    describe('GET /streaming/sse/:sessionId', () => {
      // Simple test to verify route is reachable
      it('should respond to SSE endpoint', async () => {
        mockSessionManager.getSession.mockResolvedValue(null);
        
        await request(app)
          .get('/streaming/sse/test-session-123')
          .expect(404);
          
        expect(mockSessionManager.getSession).toHaveBeenCalledWith('test-session-123');
      });
      
      it('should establish SSE connection for valid session', async () => {
        mockSessionManager.getSession.mockResolvedValue(mockSession);
        mockTransportManager.registerTransport.mockResolvedValue(undefined);
        
        // Create a short timeout test to verify SSE establishment
        try {
          await request(app)
            .get('/streaming/sse/test-session-123')
            .expect(200)
            .expect('Content-Type', /text\/event-stream/)
            .timeout(50); // Very short timeout
        } catch (error) {
          // Timeout is expected for SSE connections
          if (!error.message.includes('timeout')) {
            throw error;
          }
        }
        
        // Verify the session manager and transport manager were called
        expect(mockSessionManager.getSession).toHaveBeenCalledWith('test-session-123');
        expect(mockTransportManager.registerTransport).toHaveBeenCalled();
      });
      
      it('should return 404 for non-existent session', async () => {
        mockSessionManager.getSession.mockResolvedValue(null);
        
        await request(app)
          .get('/streaming/sse/unknown-session')
          .expect(404)
          .expect({
            error: 'Session not found',
            sessionId: 'unknown-session'
          });
        
        expect(mockTransportManager.registerTransport).not.toHaveBeenCalled();
      });
      
      it('should return 400 for expired session', async () => {
        const expiredSession = {
          ...mockSession,
          status: 'completed' as const
        };
        mockSessionManager.getSession.mockResolvedValue(expiredSession);
        
        await request(app)
          .get('/streaming/sse/test-session-123')
          .expect(400)
          .expect({
            error: 'Session is not active',
            sessionId: 'test-session-123',
            status: 'completed'
          });
      });
      
      it('should handle transport registration failure', async () => {
        mockSessionManager.getSession.mockResolvedValue(mockSession);
        mockTransportManager.registerTransport.mockRejectedValue(
          new Error('Transport registration failed')
        );
        
        // Due to SSE transport initialization sending headers immediately,
        // registration failures result in SSE connection being established
        // but then closed due to the error
        const response = await request(app)
          .get('/streaming/sse/test-session-123')
          .expect(200);
          
        // Should have SSE headers since transport.initialize() was called
        expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      });
      
      it('should handle session manager errors', async () => {
        mockSessionManager.getSession.mockRejectedValue(
          new Error('Session database connection failed')
        );
        
        await request(app)
          .get('/streaming/sse/test-session-123')
          .expect(500)
          .expect({
            error: 'Failed to retrieve session',
            details: 'Session database connection failed'
          });
      });
    });
  });
  
  describe('Event Sending Endpoint', () => {
    describe('POST /streaming/events/:sessionId', () => {
      const mockEvent = {
        type: 'token' as const,
        sessionId: 'test-session-123',
        conversationId: 'test-conversation-456',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        data: {
          content: 'Hello',
          delta: 'Hello',
          position: 0,
          isComplete: false
        }
      };
      
      it('should send event to session transport', async () => {
        mockTransportManager.hasTransport.mockReturnValue(true);
        mockTransportManager.sendEventToSession.mockResolvedValue(undefined);
        
        await request(app)
          .post('/streaming/events/test-session-123')
          .send(mockEvent)
          .expect(200)
          .expect({ status: 'sent' });
        
        expect(mockTransportManager.sendEventToSession).toHaveBeenCalledWith(
          'test-session-123',
          mockEvent
        );
      });
      
      it('should return 404 for session without transport', async () => {
        mockTransportManager.hasTransport.mockReturnValue(false);
        
        await request(app)
          .post('/streaming/events/test-session-123')
          .send(mockEvent)
          .expect(404)
          .expect({
            error: 'No transport registered for session',
            sessionId: 'test-session-123'
          });
      });
      
      it('should return 400 for invalid event data', async () => {
        const invalidEvent = {
          type: 'invalid_type',
          sessionId: 'test-session-123'
          // Missing required fields
        };
        
        await request(app)
          .post('/streaming/events/test-session-123')
          .send(invalidEvent)
          .expect(400);
      });
      
      it('should handle transport send failures', async () => {
        mockTransportManager.hasTransport.mockReturnValue(true);
        mockTransportManager.sendEventToSession.mockRejectedValue(
          new Error('Transport send failed')
        );
        
        await request(app)
          .post('/streaming/events/test-session-123')
          .send(mockEvent)
          .expect(500)
          .expect({
            error: 'Failed to send event',
            details: 'Transport send failed'
          });
      });
    });
  });
  
  describe('Session Management Endpoints', () => {
    describe('GET /streaming/session/:sessionId/status', () => {
      it('should return session status', async () => {
        const mockSessionWithStatus = {
          ...mockSession,
          status: 'active' as const
        };
        mockSessionManager.getSession.mockResolvedValue(mockSessionWithStatus);
        mockTransportManager.hasTransport.mockReturnValue(true);
        
        await request(app)
          .get('/streaming/session/test-session-123/status')
          .expect(200)
          .expect({
            sessionId: 'test-session-123',
            status: 'active',
            hasTransport: true,
            lastActivity: '2024-01-01T00:00:00.000Z',
            expiresAt: '2024-01-01T01:00:00.000Z'
          });
      });
      
      it('should return 404 for non-existent session', async () => {
        mockSessionManager.getSession.mockResolvedValue(null);
        
        await request(app)
          .get('/streaming/session/unknown-session/status')
          .expect(404)
          .expect({
            error: 'Session not found',
            sessionId: 'unknown-session'
          });
      });
    });
    
    describe('DELETE /streaming/session/:sessionId', () => {
      it('should close session and transport', async () => {
        mockTransportManager.closeTransport.mockResolvedValue(undefined);
        
        await request(app)
          .delete('/streaming/session/test-session-123')
          .expect(200)
          .expect({
            status: 'closed',
            sessionId: 'test-session-123'
          });
        
        expect(mockTransportManager.closeTransport)
          .toHaveBeenCalledWith('test-session-123');
      });
      
      it('should handle transport close errors gracefully', async () => {
        mockTransportManager.closeTransport.mockRejectedValue(
          new Error('Transport close failed')
        );
        
        await request(app)
          .delete('/streaming/session/test-session-123')
          .expect(200)
          .expect({
            status: 'closed',
            sessionId: 'test-session-123',
            warning: 'Transport close failed'
          });
      });
    });
  });
  
  describe('Health and Statistics Endpoints', () => {
    describe('GET /streaming/health', () => {
      it('should return health status', async () => {
        mockTransportManager.getTransportCount.mockReturnValue(5);
        
        const response = await request(app)
          .get('/streaming/health')
          .expect(200);
          
        expect(response.body).toEqual({
          status: 'healthy',
          activeTransports: 5,
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        });
      });
    });
    
    describe('GET /streaming/stats', () => {
      it('should return streaming statistics', async () => {
        mockTransportManager.getTransportCount.mockReturnValue(3);
        mockSessionManager.cleanupExpiredSessions.mockResolvedValue(2);
        
        const response = await request(app)
          .get('/streaming/stats')
          .expect(200);
          
        expect(response.body).toEqual({
          activeTransports: 3,
          expiredSessions: 2,
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        });
      });
    });
  });
  
  describe('Error Handling', () => {
    it('should handle malformed JSON in event sending', async () => {
      await request(app)
        .post('/streaming/events/test-session-123')
        .send('invalid json')
        .set('Content-Type', 'application/json')
        .expect(400);
    });
    
    it('should handle missing session ID parameter', async () => {
      await request(app)
        .get('/streaming/sse/')
        .expect(404);
      
      await request(app)
        .post('/streaming/events/')
        .expect(404);
    });
    
    it('should handle internal server errors gracefully', async () => {
      mockSessionManager.getSession.mockRejectedValue(
        new Error('Session: Critical system failure')
      );
      
      await request(app)
        .get('/streaming/sse/test-session-123')
        .expect(500)
        .expect({
          error: 'Failed to retrieve session',
          details: 'Session: Critical system failure'
        });
    });
  });
});
