import * as winston from "winston";
import * as path from "path";
import * as fs from "fs";

/**
 * ChatSessionLogger creates a dedicated file-based logger for each chat session.
 *
 * Logs are written to:
 *   REACTORY_DATA/profiles/{userId}/chats/{personaId}/{conversationId}/session.log
 *
 * This isolates chat session logs from the global application log stream,
 * making it much easier to debug individual conversations locally.
 *
 * A static registry allows any service (StreamingTransportManager,
 * StreamingEndpoints, SSETransport, AI providers, etc.) to look up
 * the session logger by conversationId without needing a direct
 * reference to the ReactorConversationService.
 */
export class ChatSessionLogger {
  private logger: winston.Logger;
  private logDir: string;

  /** Global registry of active session loggers keyed by conversationId */
  private static registry: Map<string, ChatSessionLogger> = new Map();

  constructor(
    userId: string,
    personaId: string,
    conversationId: string,
  ) {
    const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
    if (!dataRoot) {
      throw new Error(
        "ChatSessionLogger requires REACTORY_DATA or APP_DATA_ROOT environment variable"
      );
    }

    // Sanitize path segments to prevent directory traversal
    const safeParts = [userId, personaId, conversationId].map((s) =>
      s.replace(/[^a-zA-Z0-9_\-]/g, "_")
    );

    this.logDir = path.join(
      dataRoot,
      "profiles",
      safeParts[0],
      "chats",
      safeParts[1],
      safeParts[2]
    );

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    const logFilePath = path.join(this.logDir, "session.log");

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "debug",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0
            ? ` ${JSON.stringify(meta)}`
            : "";
          return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
        })
      ),
      transports: [
        new winston.transports.File({
          filename: logFilePath,
          maxsize: 10 * 1024 * 1024, // 10MB per file
          maxFiles: 5,
        }),
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Static registry — allows any service to look up a logger by conversationId
  // ---------------------------------------------------------------------------

  /**
   * Register a logger in the global registry so other services
   * (StreamingTransportManager, StreamingEndpoints, etc.) can find it.
   */
  static register(conversationId: string, logger: ChatSessionLogger): void {
    ChatSessionLogger.registry.set(conversationId, logger);
  }

  /**
   * Look up a session logger by conversationId.
   * Returns null if no logger has been registered for this conversation.
   */
  static forSession(conversationId: string): ChatSessionLogger | null {
    return ChatSessionLogger.registry.get(conversationId) || null;
  }

  /**
   * Remove a logger from the registry (e.g. when a session is deleted).
   */
  static unregister(conversationId: string): void {
    ChatSessionLogger.registry.delete(conversationId);
  }

  // ---------------------------------------------------------------------------
  // Instance methods
  // ---------------------------------------------------------------------------

  /**
   * Returns the directory where session logs are stored.
   */
  getLogDir(): string {
    return this.logDir;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logger.error(message, meta);
  }

  log(
    message: string,
    meta?: Record<string, unknown>,
    level: string = "debug"
  ): void {
    this.logger.log(level, message, meta);
  }

  /**
   * Close the logger transports. Call this when the session ends.
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.on("finish", resolve);
      this.logger.end();
    });
  }
}
