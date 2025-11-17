import { describe, it, expect, jest } from '@jest/globals';

// Mock all external dependencies to avoid initialization issues
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn()
      }
    }
  }))
}));

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      get: jest.fn()
    },
    chats: {
      create: jest.fn()
    }
  })),
  FunctionCallingConfigMode: {
    AUTO: 'AUTO'
  },
  Type: {
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    BOOLEAN: 'BOOLEAN',
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY'
  }
}));

jest.mock('../../ai/macro', () => ({}));
jest.mock('../../models', () => ({}));

describe('AI Streaming Services Unit Tests', () => {
  const mockContext = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: jest.fn()
  } as any;

  describe('Streaming Capabilities', () => {
    it('should verify OpenAI streaming capabilities can be retrieved', async () => {
      // Import after mocks are set up
      const { default: OpenAIStreamingService } = await import('../../services/reactor/providers/OpenAIStreamingService');
      
      const service = new OpenAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const capabilities = await service.getStreamingCapabilities();
      
      expect(capabilities).toEqual({
        supportsTokenStreaming: true,
        supportsToolStreaming: true,
        supportsFunctionStreaming: true,
        maxConcurrentStreams: 10,
        supportedFormats: ['json', 'text', 'sse']
      });
    });

    it('should verify xAI streaming capabilities can be retrieved', async () => {
      const { default: XAIStreamingService } = await import('../../services/reactor/providers/xAIStreamingService');
      
      const service = new XAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.x.ai/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const capabilities = await service.getStreamingCapabilities();
      
      expect(capabilities).toEqual({
        supportsTokenStreaming: true,
        supportsToolStreaming: true,
        supportsFunctionStreaming: true,
        maxConcurrentStreams: 10,
        supportedFormats: ['json', 'text', 'sse']
      });
    });

    it('should verify Google AI streaming capabilities can be retrieved', async () => {
      const { default: GoogleAIStreamingService } = await import('../../services/reactor/providers/GoogleAIStreamingService');
      
      const service = new GoogleAIStreamingService({}, mockContext);

      const capabilities = await service.getStreamingCapabilities();
      
      expect(capabilities).toEqual({
        supportsTokenStreaming: true,
        supportsToolStreaming: true,
        supportsFunctionStreaming: true,
        maxConcurrentStreams: 10,
        supportedFormats: ['json', 'text', 'sse']
      });
    });
  });

  describe('Service Metadata', () => {
    it('should verify service names and versions', async () => {
      const { default: OpenAIStreamingService } = await import('../../services/reactor/providers/OpenAIStreamingService');
      const { default: XAIStreamingService } = await import('../../services/reactor/providers/xAIStreamingService');
      const { default: GoogleAIStreamingService } = await import('../../services/reactor/providers/GoogleAIStreamingService');

      const openAIService = new OpenAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const xaiService = new XAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.x.ai/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const googleService = new GoogleAIStreamingService({}, mockContext);

      expect(openAIService.toString()).toBe('OpenAIStreamingService');
      expect(openAIService.toString(true)).toBe('OpenAIStreamingService@1.0.0');
      expect(openAIService.version).toBe('1.0.0');

      expect(xaiService.toString()).toBe('XAIStreamingService');
      expect(xaiService.toString(true)).toBe('XAIStreamingService@1.0.0');
      expect(xaiService.version).toBe('1.0.0');

      expect(googleService.toString()).toBe('GoogleAIStreamingService');
      expect(googleService.toString(true)).toBe('GoogleAIStreamingService@1.0.0');
      expect(googleService.version).toBe('1.0.0');
    });

    it('should verify service tags contain streaming', async () => {
      const { default: OpenAIStreamingService } = await import('../../services/reactor/providers/OpenAIStreamingService');
      const { default: XAIStreamingService } = await import('../../services/reactor/providers/xAIStreamingService');
      const { default: GoogleAIStreamingService } = await import('../../services/reactor/providers/GoogleAIStreamingService');

      const openAIService = new OpenAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const xaiService = new XAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.x.ai/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      const googleService = new GoogleAIStreamingService({}, mockContext);

      expect(openAIService.tags).toContain('streaming');
      expect(xaiService.tags).toContain('streaming');
      expect(googleService.tags).toContain('streaming');
    });
  });

  describe('Streaming Interface Compliance', () => {
    it('should verify all services implement streaming methods', async () => {
      const { default: OpenAIStreamingService } = await import('../../services/reactor/providers/OpenAIStreamingService');
      
      const service = new OpenAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      expect(typeof service.chatStream).toBe('function');
      expect(typeof service.chatAudioStream).toBe('function');
      expect(typeof service.getStreamingCapabilities).toBe('function');

      // Verify chatStream returns an async iterator
      const chatStreamResult = service.chatStream({
        personaId: 'test-persona',
        message: 'test message'
      });
      
      expect(chatStreamResult).toBeDefined();
      expect(typeof chatStreamResult[Symbol.asyncIterator]).toBe('function');
    });
  });
});
