import { describe, it, expect, jest } from '@jest/globals';
import OpenAIStreamingService from '../../services/reactor/providers/OpenAIStreamingService';
import XAIStreamingService from '../../services/reactor/providers/xAIStreamingService';
import GoogleAIStreamingService from '../../services/reactor/providers/GoogleAIStreamingService';

// Mock all external dependencies
jest.mock('openai');
jest.mock('@google/genai');

describe('AI Streaming Services Integration', () => {
  const mockContext = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: jest.fn()
  } as any;

  describe('Service Instantiation', () => {
    it('should create OpenAI streaming service successfully', () => {
      const props = {
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      };
      
      const service = new OpenAIStreamingService(props, mockContext);
      expect(service).toBeDefined();
      expect(service.name).toBe('OpenAIStreamingService');
      expect(service.version).toBe('1.0.0');
    });

    it('should create xAI streaming service successfully', () => {
      const props = {
        apiKey: 'test-key',
        apiEndpoint: 'https://api.x.ai/v1',
        apiVersion: 'v1',
        $services: {}
      };
      
      const service = new XAIStreamingService(props, mockContext);
      expect(service).toBeDefined();
      expect(service.name).toBe('XAIStreamingService');
      expect(service.version).toBe('1.0.0');
    });

    it('should create Google AI streaming service successfully', () => {
      const props = {};
      
      const service = new GoogleAIStreamingService(props, mockContext);
      expect(service).toBeDefined();
      expect(service.name).toBe('GoogleAIStreamingService');
      expect(service.version).toBe('1.0.0');
    });
  });

  describe('Streaming Capabilities', () => {
    it('should return consistent streaming capabilities across providers', async () => {
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

      const openAICapabilities = await openAIService.getStreamingCapabilities();
      const xaiCapabilities = await xaiService.getStreamingCapabilities();
      const googleCapabilities = await googleService.getStreamingCapabilities();

      // All services should support basic streaming features
      const requiredCapabilities = {
        supportsTokenStreaming: true,
        supportsToolStreaming: true,
        supportsFunctionStreaming: true
      };

      expect(openAICapabilities).toMatchObject(requiredCapabilities);
      expect(xaiCapabilities).toMatchObject(requiredCapabilities);
      expect(googleCapabilities).toMatchObject(requiredCapabilities);

      // All should support common formats
      expect(openAICapabilities.supportedFormats).toContain('sse');
      expect(xaiCapabilities.supportedFormats).toContain('sse');
      expect(googleCapabilities.supportedFormats).toContain('sse');
    });
  });

  describe('Service Metadata', () => {
    it('should provide correct service information', () => {
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

      // Test toString methods
      expect(openAIService.toString()).toBe('OpenAIStreamingService');
      expect(openAIService.toString(true)).toBe('OpenAIStreamingService@1.0.0');

      expect(xaiService.toString()).toBe('XAIStreamingService');
      expect(xaiService.toString(true)).toBe('XAIStreamingService@1.0.0');

      expect(googleService.toString()).toBe('GoogleAIStreamingService');
      expect(googleService.toString(true)).toBe('GoogleAIStreamingService@1.0.0');

      // Test service properties
      expect(openAIService.nameSpace).toBe('reactor');
      expect(xaiService.nameSpace).toBe('reactor');
      expect(googleService.nameSpace).toBe('reactor');

      // Test tags
      expect(openAIService.tags).toContain('streaming');
      expect(xaiService.tags).toContain('streaming');
      expect(googleService.tags).toContain('streaming');
    });
  });

  describe('Service Architecture', () => {
    it('should implement streaming interface correctly', () => {
      const openAIService = new OpenAIStreamingService({
        apiKey: 'test-key',
        apiEndpoint: 'https://api.openai.com/v1',
        apiVersion: 'v1',
        $services: {}
      }, mockContext);

      // Check that streaming methods exist
      expect(typeof openAIService.chatStream).toBe('function');
      expect(typeof openAIService.chatAudioStream).toBe('function');
      expect(typeof openAIService.getStreamingCapabilities).toBe('function');

      // Check that async generators are returned
      const chatStreamResult = openAIService.chatStream({
        personaId: 'test',
        message: 'test'
      });
      
      expect(chatStreamResult).toBeDefined();
      expect(typeof chatStreamResult[Symbol.asyncIterator]).toBe('function');
    });
  });
});
