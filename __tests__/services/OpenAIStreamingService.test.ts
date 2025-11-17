import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import OpenAIStreamingService from '../../services/reactor/providers/OpenAIStreamingService';
import { AIChatParams } from '../../types/model.types';
import { AIStreamingEvent } from '../../types/service.types';

// Mock the OpenAI SDK
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn()
      }
    }
  }))
}));

// Mock dependencies
const mockContext = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getService: jest.fn()
} as any;

const mockPersonaProvider = {
  getPersona: jest.fn()
} as any;

describe('OpenAIStreamingService', () => {
  let service: OpenAIStreamingService;
  
  beforeEach(() => {
    const props = {
      apiKey: 'test-key',
      apiEndpoint: 'https://api.openai.com/v1',
      apiVersion: 'v1',
      $services: {}
    };
    
    service = new OpenAIStreamingService(props, mockContext);
    service.setPersonaProvider(mockPersonaProvider);
    
    // Reset mocks
    jest.clearAllMocks();
  });

  describe('getStreamingCapabilities', () => {
    it('should return correct streaming capabilities', async () => {
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

  describe('chatStream', () => {
    it('should emit error event when persona not found', async () => {
      mockPersonaProvider.getPersona.mockResolvedValue(null);
      
      const params: AIChatParams = {
        personaId: 'test-persona',
        message: 'Hello world',
        chatSessionId: 'test-session'
      };

      const events: AIStreamingEvent[] = [];
      let hasError = false;
      
      try {
        for await (const event of service.chatStream(params)) {
          events.push(event);
        }
      } catch (error) {
        hasError = true;
        expect(error).toBeDefined();
      }

      expect(hasError || events.some(event => event.type === 'error')).toBe(true);
    });

    it('should handle invalid parameters gracefully', async () => {
      const invalidParams = {} as AIChatParams;
      
      const events: AIStreamingEvent[] = [];
      let hasError = false;
      
      try {
        for await (const event of service.chatStream(invalidParams)) {
          events.push(event);
        }
      } catch (error) {
        hasError = true;
        expect(error).toBeDefined();
      }

      // Should either throw or emit error events
      expect(hasError || events.some(event => event.type === 'error')).toBe(true);
    });
  });

  describe('toString', () => {
    it('should return correct service name', () => {
      expect(service.toString()).toBe('OpenAIStreamingService');
      expect(service.toString(true)).toBe('OpenAIStreamingService@1.0.0');
    });
  });
});
