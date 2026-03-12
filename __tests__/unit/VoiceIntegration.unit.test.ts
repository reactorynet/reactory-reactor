import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock external dependencies
jest.mock('@reactorynet/reactory-core', () => ({}), { virtual: true });
jest.mock('@reactory/reactory-core', () => ({}), { virtual: true });
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } }
  }))
}));
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(),
  FunctionCallingConfigMode: { AUTO: 'AUTO' },
  Type: { STRING: 'STRING' }
}));
jest.mock('../../ai/macro', () => ({}));
jest.mock('../../models', () => ({}));
jest.mock('../../models/ReactorChatState', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn() }),
  },
}));

// Mock the decorators
jest.mock('@reactory/server-core/application/decorators', () => ({
  service: () => (target: any) => target,
}), { virtual: true });
jest.mock('@reactory/server-core/application/decorators/service', () => ({
  service: () => (target: any) => target,
}), { virtual: true });
jest.mock('@reactory/server-core/models/graphql/decorators/resolver', () => ({
  resolver: (target: any) => target,
  mutation: () => () => {},
  query: () => () => {},
  property: () => () => {},
}), { virtual: true });
jest.mock('@reactory/server-core/authentication/decorators', () => ({
  roles: () => () => {},
}), { virtual: true });
jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}), { virtual: true });
jest.mock('exceptions', () => {
  class ApiError extends Error {
    constructor(name: string, details?: any) {
      super(details?.message || name);
      this.name = name;
    }
  }
  return { __esModule: true, default: ApiError };
}, { virtual: true });

// ---- Helpers ----

function createMockSpeechService() {
  return {
    transcribe: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      text: 'Hello from audio',
      language: 'en',
      segments: [],
      duration: 1.5,
    }),
    synthesize: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      audioBuffer: Buffer.from('fake-audio-data'),
      duration: 2.0,
      format: 'wav',
      sampleRate: 24000,
    }),
    getVoices: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
    getCapabilities: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      tts: true, stt: true, streaming: true, voices: [],
    }),
    getTTSStreamUrl: jest.fn<(...args: any[]) => string>().mockReturnValue('ws://localhost:8765/api/tts/stream'),
    getSTTStreamUrl: jest.fn<(...args: any[]) => string>().mockReturnValue('ws://localhost:8765/api/stt/stream'),
  };
}

function createMockContext(services: Record<string, any> = {}) {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    user: { _id: 'user-123', id: 'user-123', firstName: 'Test', lastName: 'User' },
    getService: jest.fn<(...args: any[]) => any>().mockImplementation((id: string) => {
      if (services[id]) return services[id];
      throw new Error(`Service not found: ${id}`);
    }),
    hasAnyRole: jest.fn<(...args: any[]) => boolean>().mockReturnValue(true),
  } as any;
}

// ---- Tests ----

describe('Voice Integration - Phase 3', () => {

  describe('AIProviderBase - speech2Text', () => {
    let AIProviderBase: any;

    beforeEach(async () => {
      // Dynamic import after mocks
      const mod = await import('../../services/reactor/providers/AIProviderBase');
      AIProviderBase = mod.default;
    });

    it('should transcribe base64 string audio via SpeechService', async () => {
      const mockSpeech = createMockSpeechService();
      const ctx = createMockContext({ 'speech.SpeechService@1.0.0': mockSpeech });

      // Create a minimal concrete subclass
      class TestProvider extends AIProviderBase {
        async chat() { return {} as any; }
      }
      const provider = new TestProvider({}, ctx);

      const base64Audio = Buffer.from('test-audio').toString('base64');
      const result = await provider.speech2Text(base64Audio);

      expect(result).toBe('Hello from audio');
      expect(mockSpeech.transcribe).toHaveBeenCalledTimes(1);
      const calledBuffer = mockSpeech.transcribe.mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(calledBuffer)).toBe(true);
    });

    it('should transcribe Buffer[] audio via SpeechService', async () => {
      const mockSpeech = createMockSpeechService();
      const ctx = createMockContext({ 'speech.SpeechService@1.0.0': mockSpeech });

      class TestProvider extends AIProviderBase {
        async chat() { return {} as any; }
      }
      const provider = new TestProvider({}, ctx);

      const buffers = [Buffer.from('chunk1'), Buffer.from('chunk2')];
      const result = await provider.speech2Text(buffers);

      expect(result).toBe('Hello from audio');
      const calledBuffer = mockSpeech.transcribe.mock.calls[0][0] as Buffer;
      expect(calledBuffer.toString()).toBe('chunk1chunk2');
    });

    it('should throw when SpeechService is not available', async () => {
      const ctx = createMockContext(); // no speech service registered

      class TestProvider extends AIProviderBase {
        async chat() { return {} as any; }
      }
      const provider = new TestProvider({}, ctx);

      await expect(provider.speech2Text('some-audio')).rejects.toThrow(
        /SpeechService is not available/
      );
    });
  });

  describe('AIProviderBase - chatAudio', () => {
    let AIProviderBase: any;

    beforeEach(async () => {
      const mod = await import('../../services/reactor/providers/AIProviderBase');
      AIProviderBase = mod.default;
    });

    it('should transcribe audio then delegate to chat()', async () => {
      const mockSpeech = createMockSpeechService();
      const ctx = createMockContext({ 'speech.SpeechService@1.0.0': mockSpeech });

      const mockChatResult = {
        id: 'completion-1',
        object: 'chat.completion',
        created: new Date(),
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      };

      class TestProvider extends AIProviderBase {
        async chat() { return mockChatResult; }
      }
      const provider = new TestProvider({}, ctx);
      jest.spyOn(provider, 'chat');

      const result = await provider.chatAudio({
        personaId: 'persona-1',
        message: '',
        audio: Buffer.from('test-audio').toString('base64'),
        format: 'wav',
      });

      expect(mockSpeech.transcribe).toHaveBeenCalledTimes(1);
      expect(provider.chat).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello from audio' })
      );
      expect(result).toBe(mockChatResult);
    });

    it('should throw when SpeechService is not available', async () => {
      const ctx = createMockContext();

      class TestProvider extends AIProviderBase {
        async chat() { return {} as any; }
      }
      const provider = new TestProvider({}, ctx);

      await expect(
        provider.chatAudio({
          personaId: 'p1',
          message: '',
          audio: 'base64audio',
          format: 'wav',
        })
      ).rejects.toThrow(/SpeechService is not available/);
    });
  });

  describe('ReactorChatResolver - ReactorAskQuestionAudio', () => {
    it('should use SpeechService to transcribe audio and send message', async () => {
      const mockSpeech = createMockSpeechService();
      const mockConversationService = {
        sendMessage: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
          __typename: 'ReactorChatMessage',
          sessionId: 'session-1',
          content: 'The answer is 42',
          role: 'assistant',
        }),
      };

      const ctx = createMockContext({
        'speech.SpeechService@1.0.0': mockSpeech,
        'reactor.ReactorConversationService@1.0.0': mockConversationService,
      });

      // Import the resolver
      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      // Mock the GraphQL Upload
      const audioUpload = {
        createReadStream: () => {
          const { Readable } = require('stream');
          const stream = new Readable();
          stream.push(Buffer.from('fake-audio'));
          stream.push(null);
          return stream;
        },
        filename: 'audio.wav',
        mimetype: 'audio/wav',
      };

      const result = await resolver.ReactorAskQuestionAudio(
        null,
        { audio: Promise.resolve(audioUpload), personaId: 'persona-1', chatSessionId: 'session-1' },
        ctx
      );

      expect(mockSpeech.transcribe).toHaveBeenCalledTimes(1);
      expect(mockConversationService.sendMessage).toHaveBeenCalledWith({
        personaId: 'persona-1',
        chatSessionId: 'session-1',
        message: 'Hello from audio',
      });
      expect(result).toEqual(expect.objectContaining({ content: 'The answer is 42' }));
    });

    it('should return error response on failure', async () => {
      const ctx = createMockContext(); // no speech service

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const result = await resolver.ReactorAskQuestionAudio(
        null,
        { audio: Promise.resolve({}), personaId: 'p1', chatSessionId: 's1' },
        ctx
      );

      expect(result.__typename).toBe('ReactorErrorResponse');
      expect(result.code).toBe('AUDIO_PROCESSING_ERROR');
    });
  });

  describe('ReactorChatResolver - Voice Session Mutations', () => {
    it('should start a voice session with stream URLs', async () => {
      const mockSpeech = createMockSpeechService();
      const mockConversationService = {
        startChatSession: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
          id: 'new-session-123',
          _id: 'new-session-123',
        }),
      };

      const ctx = createMockContext({
        'speech.SpeechService@1.0.0': mockSpeech,
        'reactor.ReactorConversationService@1.0.0': mockConversationService,
      });

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const result = await resolver.ReactorStartVoiceSession(
        null,
        {
          input: {
            personaId: 'persona-1',
            message: 'Hello',
            ttsEnabled: true,
            sttEnabled: true,
            voice: 'af_heart',
          },
        },
        ctx
      );

      expect(result.__typename).toBe('ReactorVoiceSession');
      expect(result.chatSessionId).toBe('new-session-123');
      expect(result.ttsEnabled).toBe(true);
      expect(result.sttEnabled).toBe(true);
      expect(result.voice).toBe('af_heart');
      expect(result.ttsStreamUrl).toContain('ws://');
      expect(result.sttStreamUrl).toContain('ws://');
    });

    it('should attach to existing chat session when chatSessionId provided', async () => {
      const mockSpeech = createMockSpeechService();
      const mockConversationService = {
        startChatSession: jest.fn(),
      };

      const ctx = createMockContext({
        'speech.SpeechService@1.0.0': mockSpeech,
        'reactor.ReactorConversationService@1.0.0': mockConversationService,
      });

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const result = await resolver.ReactorStartVoiceSession(
        null,
        {
          input: {
            personaId: 'persona-1',
            chatSessionId: 'existing-session-456',
          },
        },
        ctx
      );

      expect(result.__typename).toBe('ReactorVoiceSession');
      expect(result.chatSessionId).toBe('existing-session-456');
      // Should NOT create a new session
      expect(mockConversationService.startChatSession).not.toHaveBeenCalled();
    });

    it('should end a voice session and return true', async () => {
      const ctx = createMockContext();

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const result = await resolver.ReactorEndVoiceSession(
        null,
        { chatSessionId: 'session-1' },
        ctx
      );

      expect(result).toBe(true);
    });

    it('should send a voice message with TTS synthesis', async () => {
      const mockSpeech = createMockSpeechService();
      const mockConversationService = {
        sendMessage: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
          __typename: 'ReactorChatMessage',
          content: 'I can help with that',
          role: 'assistant',
        }),
      };

      const ctx = createMockContext({
        'speech.SpeechService@1.0.0': mockSpeech,
        'reactor.ReactorConversationService@1.0.0': mockConversationService,
      });

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const audioUpload = {
        createReadStream: () => {
          const { Readable } = require('stream');
          const stream = new Readable();
          stream.push(Buffer.from('audio-data'));
          stream.push(null);
          return stream;
        },
      };

      const result = await resolver.ReactorSendVoiceMessage(
        null,
        {
          audio: Promise.resolve(audioUpload),
          input: {
            chatSessionId: 'session-1',
            personaId: 'persona-1',
            synthesizeResponse: true,
            voice: 'af_heart',
          },
        },
        ctx
      );

      expect(result.__typename).toBe('ReactorVoiceChatMessage');
      expect(result.content).toBe('I can help with that');
      expect(result.audioBase64).toBeTruthy();
      expect(result.audioFormat).toBe('wav');
      expect(result.audioDuration).toBe(2.0);

      // Verify TTS was called
      expect(mockSpeech.synthesize).toHaveBeenCalledWith(
        'I can help with that',
        { voice: 'af_heart' }
      );
    });

    it('should send a voice message without TTS synthesis', async () => {
      const mockSpeech = createMockSpeechService();
      const mockConversationService = {
        sendMessage: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
          content: 'Text only response',
        }),
      };

      const ctx = createMockContext({
        'speech.SpeechService@1.0.0': mockSpeech,
        'reactor.ReactorConversationService@1.0.0': mockConversationService,
      });

      const { default: ReactorChatResolver } = await import(
        '../../graphql/resolvers/ReactorChat'
      );
      const resolver = new ReactorChatResolver();

      const audioUpload = {
        createReadStream: () => {
          const { Readable } = require('stream');
          const stream = new Readable();
          stream.push(Buffer.from('audio-data'));
          stream.push(null);
          return stream;
        },
      };

      const result = await resolver.ReactorSendVoiceMessage(
        null,
        {
          audio: Promise.resolve(audioUpload),
          input: {
            chatSessionId: 'session-1',
            personaId: 'persona-1',
            synthesizeResponse: false,
          },
        },
        ctx
      );

      expect(result.__typename).toBe('ReactorVoiceChatMessage');
      expect(result.content).toBe('Text only response');
      expect(result.audioBase64).toBeNull();
      // synthesize should NOT have been called
      expect(mockSpeech.synthesize).not.toHaveBeenCalled();
    });
  });

  describe('Streaming Types - Voice Config', () => {
    it('should allow creating a session with voice config', () => {
      const session = {
        sessionId: 'test-session',
        conversationId: 'conv-1',
        userId: 'user-1',
        transport: 'websocket' as const,
        status: 'active' as const,
        createdAt: new Date(),
        lastActivity: new Date(),
        expiresAt: new Date(),
        capabilities: {
          supportsTokenStreaming: true,
          supportsToolStreaming: true,
          maxTokensPerSecond: 100,
        },
        voice: {
          ttsEnabled: true,
          sttEnabled: true,
          voiceId: 'af_heart',
          sttLanguage: 'en',
        },
      };

      expect(session.voice).toBeDefined();
      expect(session.voice!.ttsEnabled).toBe(true);
      expect(session.voice!.voiceId).toBe('af_heart');
    });

    it('should allow creating a session without voice config', () => {
      const session = {
        sessionId: 'test-session',
        conversationId: 'conv-1',
        userId: 'user-1',
        transport: 'sse' as const,
        status: 'active' as const,
        createdAt: new Date(),
        lastActivity: new Date(),
        expiresAt: new Date(),
        capabilities: {
          supportsTokenStreaming: true,
          supportsToolStreaming: false,
          maxTokensPerSecond: 50,
        },
      };

      expect(session.voice).toBeUndefined();
    });
  });
});
