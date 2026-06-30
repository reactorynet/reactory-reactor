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

const makeEvent = (type: string = 'token'): StreamingEvent => ({
  type: type as StreamingEvent['type'],
  sessionId: SSE_ID,
  conversationId: CHAT_ID,
  messageId: 'msg-1',
  timestamp: new Date('2024-01-01T00:00:00Z'),
  data: { content: 'Hello', delta: 'Hello', position: 0, isComplete: false },
});

describe('StreamingTransportManager', () => {
  let manager: StreamingTransportManager;
  let mockTransport: jest.Mocked<StreamingTransport>;

  beforeEach(() => {
    (StreamingTransportManager as any).instance = undefined;
    manager = new StreamingTransportManager({}, mockContext);
    (manager as any).sessionManager = mockSessionManager;
    mockTransport = createMockTransport();
    jest.clearAllMocks();
  });

  describe('registerTransport', () => {
    it('should register and initialize a transport', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      expect(mockTransport.initialize).toHaveBeenCalled();
      expect(manager.hasTransport(SSE_ID)).toBe(true);
    });

    it('should evict a previous transport for the same chat session on reconnect', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      const newTransport = createMockTransport();
      const newSseId = 'sse-session-789';
      await manager.registerTransport({
        sessionId: newSseId,
        chatSessionId: CHAT_ID,
        transport: newTransport,
      });

      expect(mockTransport.close).toHaveBeenCalled();
      expect(manager.hasTransport(SSE_ID)).toBe(false);
      expect(manager.hasTransport(newSseId)).toBe(true);
    });

    it('should handle transport initialization failure', async () => {
      const failingTransport = createMockTransport();
      failingTransport.initialize.mockRejectedValue(new Error('Init failed'));

      await expect(manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: failingTransport,
      })).rejects.toThrow('Init failed');

      expect(manager.hasTransport(SSE_ID)).toBe(false);
    });
  });

  describe('sendEventToSession', () => {
    beforeEach(async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });
    });

    it('should send an event to the registered transport', async () => {
      const event = makeEvent();
      await manager.sendEventToSession(CHAT_ID, event);

      expect(mockTransport.sendEvent).toHaveBeenCalledWith(event);
    });

    it('should buffer (not throw) when no session mapping exists', async () => {
      const event = makeEvent();

      await manager.sendEventToSession('unknown-chat-id', event);

      expect(mockTransport.sendEvent).not.toHaveBeenCalled();
    });

    it('should buffer (not throw) when the transport is disconnected', async () => {
      (mockTransport as any).isConnected = false;
      const event = makeEvent();

      await manager.sendEventToSession(CHAT_ID, event);

      expect(mockTransport.sendEvent).not.toHaveBeenCalled();
      expect(manager.hasTransport(SSE_ID)).toBe(false);
    });

    it('should throw and buffer when a connected transport send fails', async () => {
      mockTransport.sendEvent.mockRejectedValue(new Error('Send failed'));
      const event = makeEvent();

      await expect(manager.sendEventToSession(CHAT_ID, event))
        .rejects.toThrow('Send failed');
    });

    it('should update session last activity after a successful send', async () => {
      const mockSession = {
        sessionId: SSE_ID,
        conversationId: CHAT_ID,
        userId: 'user-1',
        transport: 'sse' as const,
        status: 'active' as const,
        createdAt: new Date(),
        lastActivity: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        capabilities: { supportsTokenStreaming: true, supportsToolStreaming: false },
      };
      mockSessionManager.getSession.mockResolvedValue(mockSession);

      await manager.sendEventToSession(CHAT_ID, makeEvent());

      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(mockSessionManager.updateSession).toHaveBeenCalledWith(
        SSE_ID,
        expect.objectContaining({ lastActivity: expect.any(Date) }),
      );
    });
  });

  describe('event buffering on disconnect and flush on reconnect', () => {
    it('should buffer events while disconnected and flush them on reconnect', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      (mockTransport as any).isConnected = false;

      const event1 = makeEvent('token');
      const event2 = makeEvent('token');
      const completeEvent = makeEvent('complete');

      await manager.sendEventToSession(CHAT_ID, event1);
      await manager.sendEventToSession(CHAT_ID, event2);
      await manager.sendEventToSession(CHAT_ID, completeEvent);

      expect(mockTransport.sendEvent).not.toHaveBeenCalled();

      const newTransport = createMockTransport(true);
      const newSseId = 'sse-session-999';
      await manager.registerTransport({
        sessionId: newSseId,
        chatSessionId: CHAT_ID,
        transport: newTransport,
      });

      expect(newTransport.sendEvent).toHaveBeenCalledTimes(3);
      expect(newTransport.sendEvent).toHaveBeenNthCalledWith(1, event1);
      expect(newTransport.sendEvent).toHaveBeenNthCalledWith(2, event2);
      expect(newTransport.sendEvent).toHaveBeenNthCalledWith(3, completeEvent);
    });

    it('should buffer events when no transport is registered and flush on register', async () => {
      const event1 = makeEvent('token');
      const event2 = makeEvent('complete');

      await manager.sendEventToSession(CHAT_ID, event1);
      await manager.sendEventToSession(CHAT_ID, event2);

      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      expect(mockTransport.sendEvent).toHaveBeenCalledTimes(2);
      expect(mockTransport.sendEvent).toHaveBeenNthCalledWith(1, event1);
      expect(mockTransport.sendEvent).toHaveBeenNthCalledWith(2, event2);
    });
  });

  describe('closeTransport', () => {
    it('should close and unregister a transport', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      await manager.closeTransport(SSE_ID);

      expect(mockTransport.close).toHaveBeenCalled();
      expect(manager.hasTransport(SSE_ID)).toBe(false);
    });

    it('should be idempotent for an unknown session', async () => {
      await manager.closeTransport('unknown-sse-id');
    });

    it('should handle transport close failure gracefully', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });
      mockTransport.close.mockRejectedValue(new Error('Close failed'));

      await manager.closeTransport(SSE_ID);

      expect(manager.hasTransport(SSE_ID)).toBe(false);
    });
  });

  describe('closeAllTransports', () => {
    it('should close all registered transports', async () => {
      const transport1 = createMockTransport();
      const transport2 = createMockTransport();

      await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport: transport1 });
      await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: 'chat-2', transport: transport2 });

      await manager.closeAllTransports();

      expect(transport1.close).toHaveBeenCalled();
      expect(transport2.close).toHaveBeenCalled();
      expect(manager.getTransportCount()).toBe(0);
    });
  });

  describe('getTransportCount', () => {
    it('should return the correct count', async () => {
      expect(manager.getTransportCount()).toBe(0);

      await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport: mockTransport });
      expect(manager.getTransportCount()).toBe(1);

      const transport2 = createMockTransport();
      await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: 'chat-2', transport: transport2 });
      expect(manager.getTransportCount()).toBe(2);

      await manager.closeTransport('sse-1');
      expect(manager.getTransportCount()).toBe(1);
    });
  });

  describe('hasTransport', () => {
    it('should return true for a connected transport', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });

      expect(manager.hasTransport(SSE_ID)).toBe(true);
    });

    it('should return false and clean up for a disconnected transport', async () => {
      await manager.registerTransport({
        sessionId: SSE_ID,
        chatSessionId: CHAT_ID,
        transport: mockTransport,
      });
      (mockTransport as any).isConnected = false;

      expect(manager.hasTransport(SSE_ID)).toBe(false);
      expect(manager.getTransportCount()).toBe(0);
    });

    it('should return false for an unknown session', () => {
      expect(manager.hasTransport('unknown-sse-id')).toBe(false);
    });
  });

  describe('cleanupDisconnectedTransports', () => {
    it('should close disconnected transports and keep connected ones', async () => {
      const connected = createMockTransport(true);
      const disconnected = createMockTransport(false);

      await manager.registerTransport({ sessionId: 'sse-1', chatSessionId: 'chat-1', transport: connected });
      await manager.registerTransport({ sessionId: 'sse-2', chatSessionId: 'chat-2', transport: disconnected });

      const cleanedCount = await manager.cleanupDisconnectedTransports();

      expect(cleanedCount).toBe(1);
      expect(manager.hasTransport('sse-1')).toBe(true);
      expect(manager.hasTransport('sse-2')).toBe(false);
    });
  });
});
