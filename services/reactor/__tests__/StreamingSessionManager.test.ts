import { StreamingSessionManager } from '../StreamingSessionManager';
import { RedisService } from '@reactory/server-modules/reactory-core/services/RedisService';
import { 
  StreamingSession, 
  CreateStreamingSessionArgs
} from '../types/streaming.types';

// Mock RedisService
jest.mock('@reactory/server-modules/reactory-core/services/RedisService');

/** Minimal Reactory context — the manager only logs through it. */
const mockContext = {
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getService: jest.fn(),
} as any;

describe('StreamingSessionManager', () => {
  let sessionManager: StreamingSessionManager;
  let mockRedisService: jest.Mocked<RedisService>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create mock Redis client methods
    const mockRedisClient = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      pipeline: jest.fn(() => ({
        del: jest.fn(),
        srem: jest.fn(),
        exec: jest.fn().mockResolvedValue([])
      }))
    } as any;
    
    // Create mock Redis service
    mockRedisService = {
      getJSON: jest.fn(),
      setJSON: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      ttl: jest.fn().mockResolvedValue(3600),
      getClient: jest.fn(() => mockRedisClient)
    } as any;

    // StreamingSessionManager is a DI service: its constructor takes
    // (props, context) and ServiceManager injects redisService afterwards by
    // calling set${alias}. Passing the mock as the first constructor argument —
    // as this suite used to — left redisService undefined, so every method
    // threw "Redis service not available".
    //
    // It is also a singleton whose constructor returns the existing instance,
    // so the instance has to be discarded between tests or this beforeEach is a
    // no-op after the first one and state leaks across cases.
    StreamingSessionManager.resetInstanceForTesting();
    sessionManager = new StreamingSessionManager({}, mockContext);
    sessionManager.setRedisService(mockRedisService);
  });

  describe('constructor', () => {
    it('should create a StreamingSessionManager instance', () => {
      expect(sessionManager).toBeInstanceOf(StreamingSessionManager);
    });
  });

  describe('createSession', () => {
    const mockCreateArgs: CreateStreamingSessionArgs = {
      conversationId: 'test-conversation-id',
      userId: 'test-user-id',
      transport: 'sse',
      capabilities: {
        supportsTokenStreaming: true,
        supportsToolStreaming: false,
        bufferSize: 1024,
        timeoutMs: 30000
      }
    };

    it('should be defined as a method', () => {
      expect(typeof sessionManager.createSession).toBe('function');
    });

    it('should create a new streaming session successfully', async () => {
      mockRedisService.setJSON.mockResolvedValue('OK');
      
      const session = await sessionManager.createSession(mockCreateArgs);
      
      expect(session).toHaveProperty('sessionId');
      expect(session.conversationId).toBe(mockCreateArgs.conversationId);
      expect(session.userId).toBe(mockCreateArgs.userId);
      expect(session.transport).toBe(mockCreateArgs.transport);
      expect(session.status).toBe('active');
      expect(session.capabilities).toEqual(mockCreateArgs.capabilities);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActivity).toBeInstanceOf(Date);
      expect(session.expiresAt).toBeInstanceOf(Date);
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify Redis operations
      expect(mockRedisService.setJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:'),
        session,
        3600 // 1 hour in seconds
      );
      expect(mockRedisService.getClient).toHaveBeenCalled();
    });

    it('should generate unique session IDs', async () => {
      mockRedisService.setJSON.mockResolvedValue('OK');
      
      const session1 = await sessionManager.createSession(mockCreateArgs);
      const session2 = await sessionManager.createSession(mockCreateArgs);
      
      expect(session1.sessionId).not.toBe(session2.sessionId);
      expect(session1.sessionId).toBeTruthy();
      expect(session2.sessionId).toBeTruthy();

      // Verify both sessions were stored in Redis
      expect(mockRedisService.setJSON).toHaveBeenCalledTimes(2);
    });

    it('should validate required parameters', async () => {
      const invalidArgs = { ...mockCreateArgs, conversationId: '' };
      
      await expect(
        sessionManager.createSession(invalidArgs)
      ).rejects.toThrow('conversationId is required');
    });

    it('should validate transport parameter', async () => {
      const invalidArgs = { ...mockCreateArgs, transport: 'invalid' as any };
      
      await expect(
        sessionManager.createSession(invalidArgs)
      ).rejects.toThrow('Invalid transport type');
    });

    it('should set default expiration time', async () => {
      const session = await sessionManager.createSession(mockCreateArgs);
      const expectedExpiry = new Date(Date.now() + 3600000); // 1 hour
      const timeDiff = Math.abs(session.expiresAt.getTime() - expectedExpiry.getTime());
      
      // Allow 1 second tolerance for execution time
      expect(timeDiff).toBeLessThan(1000);
    });
  });

  describe('getSession', () => {
    let testSession: StreamingSession;

    beforeEach(async () => {
      mockRedisService.setJSON.mockResolvedValue('OK');
      
      testSession = await sessionManager.createSession({
        conversationId: 'test-conversation-id',
        userId: 'test-user-id',
        transport: 'sse',
        capabilities: {
          supportsTokenStreaming: true,
          supportsToolStreaming: false,
          bufferSize: 1024,
          timeoutMs: 30000
        }
      });
    });

    it('should be defined as a method', () => {
      expect(typeof sessionManager.getSession).toBe('function');
    });

    it('should retrieve existing session successfully', async () => {
      mockRedisService.getJSON.mockResolvedValue(testSession);
      
      const retrievedSession = await sessionManager.getSession(testSession.sessionId);
      
      expect(retrievedSession).not.toBeNull();
      expect(retrievedSession?.sessionId).toBe(testSession.sessionId);
      expect(retrievedSession?.conversationId).toBe(testSession.conversationId);
      expect(retrievedSession?.userId).toBe(testSession.userId);

      // Verify Redis getJSON was called
      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
    });

    it('should return null for non-existent session', async () => {
      mockRedisService.getJSON.mockResolvedValue(null);
      
      const result = await sessionManager.getSession('non-existent-session-id');
      expect(result).toBeNull();

      // Verify Redis getJSON was called
      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
    });

    it('should validate session ID parameter', async () => {
      await expect(
        sessionManager.getSession('')
      ).rejects.toThrow('sessionId is required');
    });

    it('should return null for expired sessions', async () => {
      // Create an expired session object
      const expiredSession = {
        ...testSession,
        expiresAt: new Date(Date.now() - 1000) // 1 second ago
      };
      
      mockRedisService.getJSON.mockResolvedValue(expiredSession);
      mockRedisService.del.mockResolvedValue(1);

      const result = await sessionManager.getSession(testSession.sessionId);
      expect(result).toBeNull();

      // Verify cleanup was called
      expect(mockRedisService.del).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
    });
  });

  describe('updateSession', () => {
    let testSession: StreamingSession;

    beforeEach(async () => {
      mockRedisService.setJSON.mockResolvedValue('OK');
      
      testSession = await sessionManager.createSession({
        conversationId: 'test-conversation-id',
        userId: 'test-user-id',
        transport: 'sse',
        capabilities: {
          supportsTokenStreaming: true,
          supportsToolStreaming: false,
          bufferSize: 1024,
          timeoutMs: 30000
        }
      });
    });

    it('should be defined as a method', () => {
      expect(typeof sessionManager.updateSession).toBe('function');
    });

    it('should update session status successfully', async () => {
      mockRedisService.getJSON.mockResolvedValue(testSession);
      mockRedisService.ttl.mockResolvedValue(3600);
      
      await sessionManager.updateSession(testSession.sessionId, {
        status: 'paused'
      });

      // Verify Redis operations
      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
      expect(mockRedisService.setJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:'),
        expect.objectContaining({
          status: 'paused'
        }),
        3600
      );
    });

    it('should update lastActivity timestamp', async () => {
      mockRedisService.getJSON.mockResolvedValue(testSession);
      mockRedisService.ttl.mockResolvedValue(3600);
      
      const originalActivity = testSession.lastActivity;
      
      // Wait a small amount to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await sessionManager.updateSession(testSession.sessionId, {
        status: 'active'
      });

      // Verify Redis operations
      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
      expect(mockRedisService.setJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:'),
        expect.objectContaining({
          status: 'active',
          lastActivity: expect.any(Date)
        }),
        3600
      );
    });

    it('should validate session ID parameter', async () => {
      await expect(
        sessionManager.updateSession('', { status: 'paused' })
      ).rejects.toThrow('sessionId is required');
    });

    it('should handle non-existent session updates', async () => {
      mockRedisService.getJSON.mockResolvedValue(null);
      
      await expect(
        sessionManager.updateSession('non-existent-id', { status: 'paused' })
      ).rejects.toThrow('Session not found');

      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
    });

    it('should update multiple fields atomically', async () => {
      mockRedisService.getJSON.mockResolvedValue(testSession);
      mockRedisService.ttl.mockResolvedValue(3600);
      
      const updates = {
        status: 'completed' as const,
        currentMessage: {
          id: 'test-message-id',
          content: 'Test message content',
          isComplete: true,
          tokens: [] as any[]
        }
      };

      await sessionManager.updateSession(testSession.sessionId, updates);

      // Verify Redis operations
      expect(mockRedisService.getJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:')
      );
      expect(mockRedisService.setJSON).toHaveBeenCalledWith(
        expect.stringContaining('streaming:session:'),
        expect.objectContaining({
          status: 'completed',
          currentMessage: updates.currentMessage
        }),
        3600
      );
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should be defined as a method', () => {
      expect(typeof sessionManager.cleanupExpiredSessions).toBe('function');
    });

    it('should remove expired sessions and return count', async () => {
      // Mock Redis client methods for this specific test
      const mockPipeline = {
        del: jest.fn(),
        srem: jest.fn(),
        exec: jest.fn().mockResolvedValue([])
      };

      // Override the mock for this test
      (mockRedisService.getClient as jest.Mock).mockReturnValue({
        smembers: jest.fn().mockResolvedValue(['session1', 'session2']),
        pipeline: jest.fn(() => mockPipeline)
      });
      
      // Mock session data - one expired, one active
      const expiredSession = {
        sessionId: 'session1',
        conversationId: 'test-1',
        userId: 'user-1',
        transport: 'sse' as const,
        status: 'active' as const,
        createdAt: new Date(),
        lastActivity: new Date(),
        expiresAt: new Date(Date.now() - 1000), // Expired
        capabilities: { supportsTokenStreaming: true, supportsToolStreaming: false }
      };
      
      const activeSession = {
        sessionId: 'session2',
        conversationId: 'test-2',
        userId: 'user-2',
        transport: 'websocket' as const,
        status: 'active' as const,
        createdAt: new Date(),
        lastActivity: new Date(),
        expiresAt: new Date(Date.now() + 3600000), // Active
        capabilities: { supportsTokenStreaming: true, supportsToolStreaming: false }
      };

      mockRedisService.getJSON
        .mockResolvedValueOnce(expiredSession)
        .mockResolvedValueOnce(activeSession);

      const cleanedCount = await sessionManager.cleanupExpiredSessions();
      
      expect(cleanedCount).toBe(1);
      expect(mockPipeline.del).toHaveBeenCalledWith('streaming:session:session1');
      expect(mockPipeline.srem).toHaveBeenCalledWith('streaming:session:index', 'session1');
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should return 0 when no sessions are expired', async () => {
      // Mock empty session index
      (mockRedisService.getClient as jest.Mock).mockReturnValue({
        smembers: jest.fn().mockResolvedValue([])
      });

      const cleanedCount = await sessionManager.cleanupExpiredSessions();
      expect(cleanedCount).toBe(0);
    });

    it('should handle empty session storage', async () => {
      // Mock empty session index
      (mockRedisService.getClient as jest.Mock).mockReturnValue({
        smembers: jest.fn().mockResolvedValue([])
      });

      const cleanedCount = await sessionManager.cleanupExpiredSessions();
      expect(cleanedCount).toBe(0);
    });
  });
});
