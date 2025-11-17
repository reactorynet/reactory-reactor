import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '@reactory/server-modules/reactory-core/services/RedisService';
import { 
  StreamingSession, 
  CreateStreamingSessionArgs 
} from "./types/streaming.types";
import { service } from "@reactory/server-core/application/decorators/service";

/**
 * Manages streaming sessions with Redis backend
 * Handles session lifecycle, cleanup, and state synchronization
 * 
 * @class StreamingSessionManager
 */
@service({
  id: "reactor.StreamingSessionManager@1.0.0",
  nameSpace: "reactor",
  name: "StreamingSessionManager",
  version: "1.0.0",
  description: "Manages streaming sessions with Redis backend",
  dependencies: [
    {
      id: "core.RedisService@1.0.0",
      alias: "redisService",      
    }
  ],
  lifeCycle: 'singleton',
})
export class StreamingSessionManager implements Reactory.Service.IReactoryService {
  private readonly DEFAULT_EXPIRY_HOURS = 1;
  private readonly SESSION_KEY_PREFIX = 'streaming:session:';
  private readonly SESSION_INDEX_KEY = 'streaming:session:index';
  
  /**
   * The Redis service instance
   */
  private redisService?: RedisService;

  /**
   * The Reactory context instance
   */
  private context: Reactory.Server.IReactoryContext;

  private sessionMap: Map<string, string> = new Map();

  /**
   * The singleton instance of the StreamingSessionManager
   */
  private static instance: StreamingSessionManager;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    if (!StreamingSessionManager.instance) {
      this.context = context;  
      StreamingSessionManager.instance = this;
    }
    return StreamingSessionManager.instance;
  }
  
  /**
   * Generate Redis key for session
   */
  private getSessionKey(sessionId: string): string {
    return `${this.SESSION_KEY_PREFIX}${sessionId}`;
  }

  /**
   * Get TTL in seconds for session expiration
   */
  private getTTLSeconds(): number {
    return this.DEFAULT_EXPIRY_HOURS * 60 * 60; // Convert hours to seconds
  }
  
  /**
   * Create new streaming session
   * 
   * @param args - Session creation arguments
   * @returns Promise resolving to created streaming session
   */
  async createSession(args: CreateStreamingSessionArgs): Promise<StreamingSession> {
    // Validation
    if (!args.conversationId || args.conversationId.trim() === '') {
      throw new Error('conversationId is required');
    }
    
    if (!args.userId || args.userId.trim() === '') {
      throw new Error('userId is required');
    }
    
    if (!['sse', 'websocket'].includes(args.transport)) {
      throw new Error('Invalid transport type');
    }
    
    // Generate unique session ID
    const sessionId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000));
    
    // Create session object
    const session: StreamingSession = {
      sessionId,
      conversationId: args.conversationId,
      userId: args.userId,
      transport: args.transport,
      status: 'active',
      createdAt: now,
      lastActivity: now,
      expiresAt,
      capabilities: args.capabilities
    };

    this.sessionMap.set(args.conversationId, sessionId);
    
    // Store session in Redis with TTL
    if (this.redisService) {
      const sessionKey = this.getSessionKey(sessionId);
      const ttlSeconds = this.getTTLSeconds();
      
      await this.redisService.setJSON(sessionKey, session, ttlSeconds);
      
      // Add session ID to index for cleanup operations
      await this.redisService.getClient().sadd(this.SESSION_INDEX_KEY, sessionId);
      await this.redisService.expire(this.SESSION_INDEX_KEY, ttlSeconds);
    } else {
      // Fallback to in-memory storage for testing
      throw new Error('Redis service not available');
    }
    
    return session;
  }

  getSessionId(conversationId: string): string | null {
    return this.sessionMap.get(conversationId) || null;
  }

  /**
   * Get active streaming session
   * 
   * @param sessionId - ID of the session to retrieve
   * @returns Promise resolving to session or null if not found
   */
  async getSession(sessionId: string): Promise<StreamingSession | null> {
    // Validation
    if (!sessionId || sessionId.trim() === '') {
      throw new Error('sessionId is required');
    }
    
    if (!this.redisService) {
      throw new Error('Redis service not available');
    }
    
    const sessionKey = this.getSessionKey(sessionId);
    const session = await this.redisService.getJSON<StreamingSession>(sessionKey);
    
    // Return null if session doesn't exist
    if (!session) {
      return null;
    }
    
    // Check if session is expired (extra safety check, Redis TTL should handle this)
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      // Clean up expired session
      await this.redisService.del(sessionKey);
      await this.redisService.getClient().srem(this.SESSION_INDEX_KEY, sessionId);
      return null;
    }
    
    return session;
  }
  
  /**
   * Update session state atomically
   * 
   * @param sessionId - ID of the session to update
   * @param updates - Partial session updates to apply
   * @returns Promise resolving when update is complete
   */
  async updateSession(sessionId: string, updates: Partial<StreamingSession>): Promise<void> {
    // Validation
    if (!sessionId || sessionId.trim() === '') {
      throw new Error('sessionId is required');
    }
    
    if (!this.redisService) {
      throw new Error('Redis service not available');
    }
    
    const sessionKey = this.getSessionKey(sessionId);
    const existingSession = await this.redisService.getJSON<StreamingSession>(sessionKey);
    
    if (!existingSession) {
      throw new Error('Session not found');
    }
    
    // Create updated session with merged properties
    const updatedSession: StreamingSession = {
      ...existingSession,
      ...updates,
      lastActivity: new Date() // Always update last activity
    };
    
    // Store updated session with original TTL preserved
    const ttl = await this.redisService.ttl(sessionKey);
    const ttlToUse = ttl > 0 ? ttl : this.getTTLSeconds();
    
    await this.redisService.setJSON(sessionKey, updatedSession, ttlToUse);
  }
  
  /**
   * Cleanup expired sessions
   * 
   * @returns Promise resolving to number of cleaned up sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    if (!this.redisService) {
      throw new Error('Redis service not available');
    }
    
    const now = Date.now();
    let cleanedCount = 0;
    
    // Get all session IDs from the index
    const sessionIds = await this.redisService.getClient().smembers(this.SESSION_INDEX_KEY);
    
    if (sessionIds.length === 0) {
      return 0;
    }
    
    // Check each session for expiration
    const expiredSessionIds: string[] = [];
    
    for (const sessionId of sessionIds) {
      const sessionKey = this.getSessionKey(sessionId);
      const session = await this.redisService.getJSON<StreamingSession>(sessionKey);
      
      if (!session || (session.expiresAt && new Date(session.expiresAt).getTime() < now)) {
        expiredSessionIds.push(sessionId);
      }
    }
    
    // Clean up expired sessions in batch
    if (expiredSessionIds.length > 0) {
      const pipeline = this.redisService.getClient().pipeline();
      
      expiredSessionIds.forEach(sessionId => {
        const sessionKey = this.getSessionKey(sessionId);
        pipeline.del(sessionKey);
        pipeline.srem(this.SESSION_INDEX_KEY, sessionId);
      });
      
      await pipeline.exec();
      cleanedCount = expiredSessionIds.length;
    }
    
    return cleanedCount;
  }

  private setRedisService(redisService: RedisService) {
    this.redisService = redisService;
  }

  description?: string = "Manages streaming sessions with Redis backend";
  tags?: string[] = ["reactor", "streaming", "session", "manager"];
  nameSpace: string = "reactor";
  name: string = "StreamingSessionManager";
  version: string = "1.0.0";

  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}@${this.version}`;  
  }
}
