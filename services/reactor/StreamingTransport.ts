import { Response } from 'express';
import { WebSocket } from 'ws';
import { StreamingEvent } from './types/streaming.types';
import { ChatSessionLogger } from './ChatSessionLogger';

/**
 * Abstract transport interface for streaming events
 */
export interface StreamingTransport {
  /** Whether the transport is currently connected */
  readonly isConnected: boolean;

  /** Initialize the transport connection */
  initialize(): Promise<void>;

  /** Send a streaming event through the transport */
  sendEvent(event: StreamingEvent): Promise<void>;

  /** Close the transport connection */
  close(): Promise<void>;
}

/**
 * Server-Sent Events (SSE) transport implementation
 * Provides HTTP-based real-time streaming using the EventSource API
 */
export class SSETransport implements StreamingTransport {
  private _isConnected = false;
  private _isClosed = false;
  /** The conversationId this transport serves — set on first sendEvent */
  private _chatSessionId: string | null = null;

  constructor(private readonly response: Response) {}

  get isConnected(): boolean {
    if (!this._isConnected || this._isClosed) return false;
    return !this.response.writableEnded && !this.response.destroyed;
  }

  /**
   * Log to the session file logger if a chatSessionId has been associated.
   */
  private slog(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    if (this._chatSessionId) {
      ChatSessionLogger.forSession(this._chatSessionId)?.[level](
        `[SSETransport] ${message}`, meta
      );
    }
  }

  /**
   * Initialize SSE connection with proper headers and event handlers
   */
  async initialize(): Promise<void> {
    if (this._isConnected) {
      throw new Error('SSE transport already initialized');
    }

    if (this._isClosed) {
      throw new Error('SSE transport has been closed');
    }

    this.slog("debug", "Initializing SSE transport...");

    // Set SSE headers
    this.response.setHeader('Content-Type', 'text/event-stream');
    this.response.setHeader('Cache-Control', 'no-cache');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no');
    this.response.setHeader('Access-Control-Allow-Origin', '*');
    this.response.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

    // Flush headers immediately to establish the SSE connection
    this.response.flushHeaders();

    // Handle client disconnect
    this.response.on('close', () => {
      this.slog("info", "Client disconnected, closing transport");
      this._isConnected = false;
      this._isClosed = true;
    });

    this.response.on('error', (err) => {
      this.slog("warn", `Response error, marking transport disconnected: ${err.message}`);
      this._isConnected = false;
    });

    // Send initial connection event
    this.response.write('event: connected\ndata: {}\n\n');

    this._isConnected = true;
    this.slog("info", "SSE transport initialized successfully");
  }

  /**
   * Send streaming event in SSE format
   */
  async sendEvent(event: StreamingEvent): Promise<void> {
    if (!this._isConnected) {
      throw new Error('SSE transport not initialized');
    }

    if (this._isClosed) {
      throw new Error('SSE transport has been closed');
    }

    // Capture the conversationId from the first event so subsequent logs
    // are routed to the correct session file.
    if (!this._chatSessionId && event.conversationId) {
      this._chatSessionId = event.conversationId;
    }

    try {
      const eventData = JSON.stringify(event);
      const sseMessage = `event: ${event.type}\ndata: ${eventData}\n\n`;

      this.response.write(sseMessage);
      this.slog("debug", `Sent SSE event: ${event.type}`, { event });
      if (typeof (this.response as any).flush === 'function') {
        (this.response as any).flush();
      } else {
        this.response.cork();
        process.nextTick(() => this.response.uncork());
      }
    } catch (error: any) {
      this.slog("error", `Error sending SSE event: ${error.message}`, { eventType: event.type });
      this._isConnected = false;
      throw error;
    }
  }

  /**
   * Close SSE connection
   */
  async close(): Promise<void> {
    if (this._isClosed) {
      return; // Already closed
    }

    this.slog("info", "Closing SSE transport");

    try {
      if (this._isConnected) {
        // Send close event before ending
        this.response.write('event: close\ndata: {}\n\n');
      }

      this.response.end();
    } catch (error: any) {
      this.slog("warn", `Error during SSE transport close: ${error.message}`);
    } finally {
      this._isConnected = false;
      this._isClosed = true;
    }
  }
}

/**
 * WebSocket transport implementation
 * Provides bidirectional real-time communication using WebSocket protocol
 */
export class WebSocketTransport implements StreamingTransport {
  private _isConnected = false;
  private _isClosed = false;

  constructor(private readonly websocket: WebSocket) {}

  get isConnected(): boolean {
    return this._isConnected && this.websocket.readyState === WebSocket.OPEN;
  }

  /**
   * Initialize WebSocket connection with event handlers
   */
  async initialize(): Promise<void> {
    if (this._isConnected) {
      throw new Error('WebSocket transport already initialized');
    }

    if (this._isClosed) {
      throw new Error('WebSocket transport has been closed');
    }

    // Set up event handlers
    this.websocket.onopen = () => {
      this._isConnected = true;
    };

    this.websocket.onclose = () => {
      this._isConnected = false;
      this._isClosed = true;
    };

    this.websocket.onerror = (event: unknown) => {
      this._isConnected = false;
      this._isClosed = true;
    };

    // If WebSocket is already open, mark as connected
    if (this.websocket.readyState === WebSocket.OPEN) {
      this._isConnected = true;
    }
  }

  /**
   * Send streaming event as JSON message
   */
  async sendEvent(event: StreamingEvent): Promise<void> {
    if (!this._isConnected) {
      throw new Error('WebSocket transport not initialized');
    }

    if (this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    try {
      const message = JSON.stringify(event);
      this.websocket.send(message);
    } catch (error) {
      this._isConnected = false;
      throw error;
    }
  }

  /**
   * Close WebSocket connection
   */
  async close(): Promise<void> {
    if (this._isClosed) {
      return; // Already closed
    }

    try {
      if (this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.close(1000, 'Normal closure');
      }
    } catch (error) {
      // Log error but continue with cleanup
      console.warn('Error during WebSocket transport close:', error);
    } finally {
      this._isConnected = false;
      this._isClosed = true;
    }
  }
}
