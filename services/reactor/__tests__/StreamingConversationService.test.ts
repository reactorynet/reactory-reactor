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

    it('should delegate to base sendMessage for non-streaming mode', async () => {
      // Mock the base service method
      const mockResponse = {
        __typename: 'ReactorChatMessage',
        id: 'test-message-id',
        sessionId: 'test-session-id',
        content: 'Hello back!',
        role: 'assistant'
      };
      
      // Spy on the base sendMessage method
      const sendMessageSpy = jest.spyOn(streamingService, 'sendMessage').mockResolvedValue(mockResponse);
      
      const result = await streamingService.sendMessageWithStreaming(mockArgs);
      
      expect(sendMessageSpy).toHaveBeenCalledWith({
        personaId: mockArgs.personaId,
        chatSessionId: mockArgs.chatSessionId,
        message: mockArgs.message,
        role: 'user'
      });
      expect(result).toEqual(mockResponse);
      
      sendMessageSpy.mockRestore();
    });

    it('should return ReactorInitiateSSE for SSE streaming mode', async () => {
      const sseArgs = { ...mockArgs, streamingMode: 'sse' as const };
      
      const result = await streamingService.sendMessageWithStreaming(sseArgs);
      
      expect(result).toHaveProperty('__typename', 'ReactorInitiateSSE');
      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('endpoint');
      expect(result).toHaveProperty('status', 'ready');
      expect(result.endpoint).toMatch(/\/api\/reactor\/stream\//);
    });

    it('should return ReactorInitiateSSE for WebSocket streaming mode', async () => {
      const wsArgs = { ...mockArgs, streamingMode: 'websocket' as const };
      
      const result = await streamingService.sendMessageWithStreaming(wsArgs);
      
      expect(result).toHaveProperty('__typename', 'ReactorInitiateSSE');
      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('endpoint');
      expect(result).toHaveProperty('status', 'ready');
      expect(result.endpoint).toMatch(/\/api\/reactor\/ws\//);
    });

    it('should validate required parameters', async () => {
      const invalidArgs = { ...mockArgs, personaId: '' };
      
      await expect(
        streamingService.sendMessageWithStreaming(invalidArgs)
      ).rejects.toThrow('personaId is required');
    });

    it('should validate streaming mode', async () => {
      const invalidArgs = { ...mockArgs, streamingMode: 'invalid' as any };
      
      await expect(
        streamingService.sendMessageWithStreaming(invalidArgs)
      ).rejects.toThrow('Invalid streaming mode');
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

    it('should process simple token stream successfully', async () => {
      const mockTokens = ['Hello', ' ', 'world', '!'];
      const mockStream = new ReadableStream({
        start(controller) {
          mockTokens.forEach(token => controller.enqueue(token));
          controller.close();
        }
      });

      // Should complete without throwing
      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, mockStream)
      ).resolves.not.toThrow();
    });

    it('should handle empty stream gracefully', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });

      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, mockStream)
      ).resolves.not.toThrow();
    });

    it('should validate streaming session parameter', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue('token');
          controller.close();
        }
      });

      await expect(
        streamingService.processStreamingResponse(null as any, mockStream)
      ).rejects.toThrow('streamingSession is required');
    });

    it('should validate stream parameter', async () => {
      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, null as any)
      ).rejects.toThrow('aiResponse stream is required');
    });

    it('should handle stream errors gracefully', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream processing error'));
        }
      });

      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, mockStream)
      ).rejects.toThrow('Stream processing error');
    });

    it('should process JSON streaming chunks correctly', async () => {
      const mockChunks = [
        { type: 'token', data: { content: 'Hello', delta: 'Hello', position: 0 } },
        { type: 'token', data: { content: ' world', delta: ' world', position: 5 } },
        { type: 'complete', data: { content: 'Hello world', isComplete: true } }
      ];
      
      const mockStream = new ReadableStream({
        start(controller) {
          mockChunks.forEach(chunk => controller.enqueue(JSON.stringify(chunk)));
          controller.close();
        }
      });

      await expect(
        streamingService.processStreamingResponse(mockStreamingSession, mockStream)
      ).resolves.not.toThrow();
    });
  });
});
