import { StreamingConversationService } from '../StreamingConversationService';
import ReactorConversationService from '../ReactorConversationService';

// Mock dependencies
jest.mock('../ReactorConversationService');

describe('StreamingConversationService', () => {
  let streamingService: StreamingConversationService;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create service instance
    streamingService = new StreamingConversationService(
      { 
        dependencies: {},
        $services: new Map()
      } as any,
      {
        user: { _id: 'test-user' },
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        getService: jest.fn()
      } as any
    );
  });

  describe('constructor', () => {
    it('should create a StreamingConversationService that extends ReactorConversationService', () => {
      expect(streamingService).toBeInstanceOf(ReactorConversationService);
      expect(streamingService).toBeInstanceOf(StreamingConversationService);
    });

    it('should have the correct service metadata', () => {
      expect(streamingService.serviceId).toBe('reactor.StreamingConversationService@1.0.0');
    });
  });

  describe('sendMessageWithStreaming', () => {
    const mockArgs = {
      personaId: 'test-persona-id',
      chatSessionId: 'test-chat-session',
      message: 'Hello, world!',
      streamingMode: 'none' as const,
      clientCapabilities: {
        supportsTokenStreaming: true,
        supportsToolStreaming: false,
        bufferSize: 1024,
        timeoutMs: 30000
      }
    };

    it('should be defined as a method', () => {
      expect(typeof streamingService.sendMessageWithStreaming).toBe('function');
    });

    it('should throw error for not implemented (TDD approach)', async () => {
      await expect(
        streamingService.sendMessageWithStreaming(mockArgs)
      ).rejects.toThrow('sendMessageWithStreaming not implemented yet');
    });
  });

  describe('processStreamingResponse', () => {
    const mockStreamingSession = {
      sessionId: 'test-session-id',
      conversationId: 'test-conversation-id',
      userId: 'test-user-id',
      transport: 'sse' as const,
      status: 'active' as const,
      createdAt: new Date(),
      lastActivity: new Date(),
      expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      capabilities: {
        supportsTokenStreaming: true,
        supportsToolStreaming: false,
        bufferSize: 1024,
        timeoutMs: 30000
      }
    };

    it('should be defined as a method', () => {
      expect(typeof streamingService.processStreamingResponse).toBe('function');
    });

    it('should throw error for not implemented (TDD approach)', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue('token1');
          controller.enqueue('token2');
          controller.close();
        }
      });

      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, mockStream)
      ).rejects.toThrow('processStreamingResponse not implemented yet');
    });
  });
});
