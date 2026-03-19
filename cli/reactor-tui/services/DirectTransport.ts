/**
 * DirectTransport — In-process transport that calls ReactorConversationService
 * directly via DI.  Used when the CLI runs inside the server process (default
 * for `bin/cli.sh`).
 *
 * For streaming, it creates a streaming session via StreamingSessionManager and
 * polls/listens for events from the StreamingTransportManager.
 */
import { EventEmitter } from "events";
import { ObjectId } from "mongodb";
import { ChatTransport, StreamingMode, ToolApprovalMode, MacroToolDefinition, MacroComponentDefinition } from "../types";
import { StreamingEventType } from "@reactory/server-modules/reactory-reactor/services/reactor/types/streaming.types";
import { IReactorConversationsService, IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { StreamingSessionManager } from "@reactory/server-modules/reactory-reactor/services/reactor/StreamingSessionManager";
import { StreamingTransportManager } from "@reactory/server-modules/reactory-reactor/services/reactor/StreamingTransportManager";
import AIPersonaProvider from "@reactory/server-modules/reactory-reactor/services/reactor/AIPersonaProvider";
import logger from "@reactory/server-core/logging";
import fs from "fs";
import path from "path";

export class DirectTransport extends EventEmitter implements ChatTransport {
  readonly mode = "direct" as const;

  private context: Reactory.Server.IReactoryContext;
  private conversationService: IReactorConversationsService;
  private streamingSessionManager: StreamingSessionManager;
  private streamingTransportManager: StreamingTransportManager;
  private personaProvider: AIPersonaProvider;

  constructor(context: Reactory.Server.IReactoryContext) {
    super();
    this.context = context;
    this.conversationService = context.getService<IReactorConversationsService>(
      "reactor.ReactorConversationService@1.0.0"
    );
    this.streamingSessionManager = context.getService<StreamingSessionManager>(
      "reactor.StreamingSessionManager@1.0.0"
    );
    this.streamingTransportManager = context.getService<StreamingTransportManager>(
      "reactor.StreamingTransportManager@1.0.0"
    );
    this.personaProvider = context.getService<AIPersonaProvider>(
      "reactor.AIPersonaProvider@1.0.0"
    );
  }

  async sendMessage(
    message: string,
    sessionId: string,
    options?: {
      images?: string[];
      streamingMode?: StreamingMode;
    }
  ): Promise<any> {
    const streamingMode = options?.streamingMode ?? StreamingMode.SSE;

    // If images are provided, base64-encode and attach them
    // (The conversation service handles image processing)
    const persona = await this.getPersonaForSession(sessionId);
    const personaId = persona?.id || "ReactorAIPersona";

    try {
      const result = await this.conversationService.sendMessage({
        message,
        personaId,
        chatSessionId: sessionId,
        streamingMode,
      });

      // For non-streaming mode, emit a complete event
      if (streamingMode === StreamingMode.NONE) {
        this.emit("event", {
          type: StreamingEventType.COMPLETE,
          sessionId,
          conversationId: sessionId,
          messageId: new ObjectId().toHexString(),
          timestamp: new Date(),
          data: {
            content: this.extractContent(result),
            finishReason: "stop",
          },
        });
      }

      return result;
    } catch (err) {
      this.emit("event", {
        type: StreamingEventType.ERROR,
        sessionId,
        conversationId: sessionId,
        messageId: new ObjectId().toHexString(),
        timestamp: new Date(),
        data: {
          message: err instanceof Error ? err.message : String(err),
          error: err,
        },
      });
      throw err;
    }
  }

  async newChat(
    personaId: string,
    options?: {
      systemPrompt?: string;
      tools?: Partial<MacroToolDefinition>[];
      macros?: Partial<MacroComponentDefinition<unknown>>;
      toolApprovalMode?: ToolApprovalMode;
      streamingMode?: StreamingMode;
      contextFromSessionId?: string;
    }
  ): Promise<any> {
    const result = await this.conversationService.startChatSession({
      personaId,
      macros: options?.macros || ({} as any),
      tools: options?.tools || [],
      systemPrompt: options?.systemPrompt || "",
      streamingMode: options?.streamingMode ?? StreamingMode.SSE,
      promptMergeStrategy: "append",
      toolApprovalMode: options?.toolApprovalMode ?? ToolApprovalMode.AUTO,
      contextFromSessionId: options?.contextFromSessionId,
    });

    return result;
  }

  async loadChat(sessionId: string): Promise<any> {
    return this.conversationService.getChatSession({ id: sessionId });
  }

  async listChats(filter?: { personaId?: string }): Promise<any[]> {
    const conversations =
      await (this.conversationService as any).getConversations({
        personaId: filter?.personaId,
      });
    return conversations || [];
  }

  async deleteChat(sessionId: string): Promise<boolean> {
    try {
      await (this.conversationService as any).deleteChatSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async setToolApprovalMode(
    sessionId: string,
    mode: ToolApprovalMode
  ): Promise<void> {
    await this.conversationService.setChatToolApprovalMode(sessionId, mode);
  }

  async setMaxToolIterations(
    sessionId: string,
    count: number
  ): Promise<void> {
    await this.conversationService.setChatMaxToolIterations(sessionId, count);
  }

  async continueToolExecution(
    sessionId: string,
    personaId: string,
    maxIterations?: number
  ): Promise<any> {
    return this.conversationService.continueToolExecution(
      sessionId,
      personaId,
      maxIterations,
      StreamingMode.SSE
    );
  }

  async setModelProvider(
    sessionId: string,
    modelId?: string,
    providerId?: string
  ): Promise<void> {
    await this.conversationService.setChatModelProvider(
      sessionId,
      modelId,
      providerId
    );
  }

  async uploadFile(filePath: string, sessionId: string): Promise<any> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }

    const buffer = fs.readFileSync(absPath);
    const fileName = path.basename(absPath);
    const mimeType = this.guessMimeType(fileName);

    // Use the conversation service's attachFiles method
    return (this.conversationService as any).attachFiles(sessionId, [
      {
        filename: fileName,
        mimetype: mimeType,
        buffer,
      },
    ]);
  }

  async executeMacro(
    macro: string,
    personaId: string,
    sessionId: string,
    args?: any
  ): Promise<any> {
    return (this.conversationService as any).executeMacro({
      macro,
      personaId,
      chatSessionId: sessionId,
      args,
    });
  }

  disconnect(): void {
    this.removeAllListeners();
  }

  /**
   * Set up SSE event forwarding for a conversation session.
   * Called after sendMessage when using SSE streaming — the
   * StreamingTransportManager will emit events on the session
   * that we forward to TUI listeners.
   */
  async setupStreamingListener(conversationId: string): Promise<void> {
    const sessionId =
      this.streamingSessionManager.getSessionId(conversationId);
    if (!sessionId) return;

    // The StreamingTransportManager emits events keyed by sessionId
    const forwardEvent = (event: any) => {
      this.emit("event", event);
    };

    this.streamingTransportManager.on(
      `session:${sessionId}:event`,
      forwardEvent
    );

    // Clean up when session completes
    const cleanup = () => {
      this.streamingTransportManager.removeListener(
        `session:${sessionId}:event`,
        forwardEvent
      );
    };

    this.once("disconnect", cleanup);
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private async getPersonaForSession(
    sessionId: string
  ): Promise<IAIPersona | null> {
    try {
      const session = await this.conversationService.getChatSession({
        id: sessionId,
      });
      if (session && (session as any).personaId) {
        return this.personaProvider.getPersona((session as any).personaId);
      }
    } catch {
      // Session may not exist yet
    }
    return null;
  }

  private extractContent(result: any): string {
    if (typeof result === "string") return result;
    if (result?.history?.length > 0) {
      const last = result.history[result.history.length - 1];
      return last?.content || "";
    }
    if (result?.content) return result.content;
    return JSON.stringify(result);
  }

  private guessMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".js": "text/javascript",
      ".ts": "text/typescript",
      ".py": "text/x-python",
      ".html": "text/html",
      ".css": "text/css",
      ".csv": "text/csv",
      ".xml": "application/xml",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".zip": "application/zip",
    };
    return mimeMap[ext] || "application/octet-stream";
  }
}
