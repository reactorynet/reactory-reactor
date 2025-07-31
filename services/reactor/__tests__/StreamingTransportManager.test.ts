import { StreamingTransportManager } from '../StreamingTransportManager';
import { StreamingSessionManager } from '../StreamingSessionManager';
import { StreamingTransport } from '../StreamingTransport';
import { StreamingSession, StreamingEvent } from '../types/streaming.types';

// Mock dependencies
jest.mock('../StreamingSessionManager');
jest.mock('../StreamingTransport');

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

const createMockTransport = (isConnected = true) => ({
  isConnected,
  initialize: jest.fn().mockResolvedValue(undefined),
  sendEvent: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
} as jest.Mocked<StreamingTransport>);

describe('StreamingTransportManager', () => {
  let manager: StreamingTransportManager;
  let mockTransport: jest.Mocked<StreamingTransport>;
  
  beforeEach(() => {
    manager = new StreamingTransportManager(mockSessionManager);
    mockTransport = createMockTransport();
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('constructor', () => {
    it('should create manager with session manager dependency', () => {
      expect(manager).toBeInstanceOf(StreamingTransportManager);
    });
  });
  
  describe('registerTransport', () => {
    const sessionId = 'test-session-123';
    
    it('should register transport for session and initialize it', async () => {
      await manager.registerTransport(sessionId, mockTransport);
      
      expect(mockTransport.initialize).toHaveBeenCalled();
      expect(manager.hasTransport(sessionId)).toBe(true);
    });
    
    it('should throw error if transport already registered for session', async () => {
      await manager.registerTransport(sessionId, mockTransport);
      
      const newTransport = createMockTransport();
      await expect(manager.registerTransport(sessionId, newTransport))
        .rejects.toThrow('Transport already registered for session');
    });
    
    it('should handle transport initialization failure', async () => {
      const initError = new Error('Transport init failed');
      const failingTransport = createMockTransport();
      failingTransport.initialize.mockRejectedValue(initError);
      
      await expect(manager.registerTransport(sessionId, failingTransport))
        .rejects.toThrow('Transport init failed');
      
      expect(manager.hasTransport(sessionId)).toBe(false);
    });
  });
  
  describe('sendEventToSession', () => {
    const sessionId = 'test-session-123';
    const mockEvent: StreamingEvent = {
      type: 'token',
      sessionId,
      conversationId: 'test-conversation-456',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      data: {
        content: 'Hello',
        delta: 'Hello',
        position: 0,
        isComplete: false
      }
    };
    
    beforeEach(async () => {
      await manager.registerTransport(sessionId, mockTransport);
    });
    
    it('should send event to registered transport', async () => {
      await manager.sendEventToSession(sessionId, mockEvent);
      
      expect(mockTransport.sendEvent).toHaveBeenCalledWith(mockEvent);
    });
    
    it('should throw error if no transport registered for session', async () => {
      const unknownSessionId = 'unknown-session';
      
      await expect(manager.sendEventToSession(unknownSessionId, mockEvent))
        .rejects.toThrow('No transport registered for session');
    });
    
    it('should handle transport send failure', async () => {
      const sendError = new Error('Transport send failed');
      mockTransport.sendEvent.mockRejectedValue(sendError);
      
      await expect(manager.sendEventToSession(sessionId, mockEvent))
        .rejects.toThrow('Transport send failed');
    });
    
    it('should update session last activity timestamp', async () => {
      const mockSession: StreamingSession = {
        sessionId,
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
      
      mockSessionManager.getSession.mockResolvedValue(mockSession);
      
      await manager.sendEventToSession(sessionId, mockEvent);
      
      expect(mockSessionManager.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          lastActivity: expect.any(Date)
        })
      );
    });
  });
  
  describe('closeTransport', () => {
    const sessionId = 'test-session-123';
    
    beforeEach(async () => {
      await manager.registerTransport(sessionId, mockTransport);
    });
    
    it('should close transport and unregister it', async () => {
      await manager.closeTransport(sessionId);
      
      expect(mockTransport.close).toHaveBeenCalled();
      expect(manager.hasTransport(sessionId)).toBe(false);
    });
    
    it('should be idempotent for unknown session', async () => {
      const unknownSessionId = 'unknown-session';
      
      // Should not throw
      await manager.closeTransport(unknownSessionId);
    });
    
    it('should handle transport close failure gracefully', async () => {
      const closeError = new Error('Transport close failed');
      mockTransport.close.mockRejectedValue(closeError);
      
      // Should not throw, but should still unregister transport
      await manager.closeTransport(sessionId);
      
      expect(manager.hasTransport(sessionId)).toBe(false);
    });
  });
  
  describe('closeAllTransports', () => {
    it('should close all registered transports', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const transport1 = createMockTransport();
      const transport2 = createMockTransport();
      
      await manager.registerTransport(sessionId1, transport1);
      await manager.registerTransport(sessionId2, transport2);
      
      await manager.closeAllTransports();
      
      expect(transport1.close).toHaveBeenCalled();
      expect(transport2.close).toHaveBeenCalled();
      expect(manager.hasTransport(sessionId1)).toBe(false);
      expect(manager.hasTransport(sessionId2)).toBe(false);
    });
    
    it('should handle individual transport close failures', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const transport1 = createMockTransport();
      const transport2 = createMockTransport();
      
      transport1.close.mockRejectedValue(new Error('Close failed'));
      transport2.close.mockResolvedValue(undefined);
      
      await manager.registerTransport(sessionId1, transport1);
      await manager.registerTransport(sessionId2, transport2);
      
      // Should not throw, but should close all
      await manager.closeAllTransports();
      
      expect(transport1.close).toHaveBeenCalled();
      expect(transport2.close).toHaveBeenCalled();
      expect(manager.hasTransport(sessionId1)).toBe(false);
      expect(manager.hasTransport(sessionId2)).toBe(false);
    });
  });
  
  describe('getTransportCount', () => {
    it('should return correct transport count', async () => {
      expect(manager.getTransportCount()).toBe(0);
      
      await manager.registerTransport('session-1', mockTransport);
      expect(manager.getTransportCount()).toBe(1);
      
      const transport2 = createMockTransport();
      await manager.registerTransport('session-2', transport2);
      expect(manager.getTransportCount()).toBe(2);
      
      await manager.closeTransport('session-1');
      expect(manager.getTransportCount()).toBe(1);
    });
  });
  
  describe('cleanup operations', () => {
    it('should clean up disconnected transports', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const connectedTransport = createMockTransport(true);
      const disconnectedTransport = createMockTransport(false);
      
      await manager.registerTransport(sessionId1, connectedTransport);
      await manager.registerTransport(sessionId2, disconnectedTransport);
      
      const cleanedCount = await manager.cleanupDisconnectedTransports();
      
      expect(cleanedCount).toBe(1);
      expect(manager.hasTransport(sessionId1)).toBe(true);
      expect(manager.hasTransport(sessionId2)).toBe(false);
    });
  });
  
  describe('integration scenarios', () => {
    it('should handle complete transport lifecycle', async () => {
      const sessionId = 'test-session-123';
      const mockEvent: StreamingEvent = {
        type: 'token',
        sessionId,
        conversationId: 'test-conversation-456',
        timestamp: new Date(),
        data: { content: 'Test message' }
      };
      
      // Register transport
      await manager.registerTransport(sessionId, mockTransport);
      expect(manager.hasTransport(sessionId)).toBe(true);
      
      // Send events
      await manager.sendEventToSession(sessionId, mockEvent);
      expect(mockTransport.sendEvent).toHaveBeenCalledWith(mockEvent);
      
      // Close transport
      await manager.closeTransport(sessionId);
      expect(mockTransport.close).toHaveBeenCalled();
      expect(manager.hasTransport(sessionId)).toBe(false);
    });
    
    it('should handle transport registration failures gracefully', async () => {
      const sessionId = 'test-session-123';
      const failingTransport = {
        ...mockTransport,
        initialize: jest.fn().mockRejectedValue(new Error('Init failed'))
      };
      
      await expect(manager.registerTransport(sessionId, failingTransport))
        .rejects.toThrow('Init failed');
      
      // Should not be registered
      expect(manager.hasTransport(sessionId)).toBe(false);
      expect(manager.getTransportCount()).toBe(0);
    });
  });
});
