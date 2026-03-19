/**
 * HttpSseTransport — HTTP-based transport that uses the GraphQL API to send
 * messages and connects to the SSE endpoint for streaming.  Used when the CLI
 * runs outside the server process (remote mode) or as a fallback when DI
 * services are unavailable.
 */
import { EventEmitter } from "events";
import { ChatTransport, StreamingMode, ToolApprovalMode, MacroToolDefinition, MacroComponentDefinition } from "../types";
import { StreamingEventType } from "@reactory/server-modules/reactory-reactor/services/reactor/types/streaming.types";
import logger from "@reactory/server-core/logging";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { URL } from "url";

export interface HttpSseTransportOptions {
  /** Base URL of the Reactory API (e.g. http://localhost:4000) */
  apiUrl: string;
  /** JWT authentication token */
  authToken: string;
  /** Client key header */
  clientKey?: string;
}

export class HttpSseTransport extends EventEmitter implements ChatTransport {
  readonly mode = "http" as const;

  private options: HttpSseTransportOptions;
  private activeEventSource: any = null; // Node.js IncomingMessage for SSE
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(options: HttpSseTransportOptions) {
    super();
    this.options = options;
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

    const mutation = `
      mutation ReactorSendMessage($message: ReactorSendMessageInput!) {
        ReactorSendMessage(message: $message) {
          __typename
          ... on ReactorChatMessage {
            id
            content
            role
            sessionId
          }
          ... on ReactorInitiateSSE {
            sessionId
            endpoint
            token
            status
            expiry
            headers
            chatState {
              id
              personaId
            }
          }
          ... on ReactorErrorResponse {
            code
            message
            recoverable
          }
        }
      }
    `;

    const images = options?.images
      ? await Promise.all(
          options.images.map((p) => this.fileToBase64DataUrl(p))
        )
      : undefined;

    const result = await this.graphql(mutation, {
      message: {
        message,
        chatSessionId: sessionId,
        streamingMode: streamingMode === StreamingMode.SSE ? "SSE" : "NONE",
        images,
      },
    });

    const response = result?.data?.ReactorSendMessage;
    if (!response) {
      throw new Error("Empty GraphQL response");
    }

    if (response.__typename === "ReactorErrorResponse") {
      this.emit("event", {
        type: StreamingEventType.ERROR,
        sessionId,
        conversationId: sessionId,
        messageId: "",
        timestamp: new Date(),
        data: { message: response.message, code: response.code },
      });
      throw new Error(response.message);
    }

    if (response.__typename === "ReactorInitiateSSE") {
      // Connect SSE
      await this.connectSSE(
        response.endpoint,
        response.sessionId,
        response.token,
        sessionId
      );
      return response;
    }

    // Non-streaming — direct message response
    if (response.__typename === "ReactorChatMessage") {
      this.emit("event", {
        type: StreamingEventType.COMPLETE,
        sessionId,
        conversationId: sessionId,
        messageId: response.id,
        timestamp: new Date(),
        data: {
          content: response.content,
          finishReason: "stop",
        },
      });
    }

    return response;
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
    const mutation = `
      mutation ReactorStartChat($input: ReactorStartChatInput!) {
        ReactorStartChat(input: $input) {
          id
          personaId
          persona { id name description }
        }
      }
    `;

    const result = await this.graphql(mutation, {
      input: {
        personaId,
        systemPrompt: options?.systemPrompt,
        streamingMode:
          (options?.streamingMode ?? StreamingMode.SSE) === StreamingMode.SSE
            ? "SSE"
            : "NONE",
        toolApprovalMode: options?.toolApprovalMode ?? "auto",
      },
    });

    return result?.data?.ReactorStartChat;
  }

  async loadChat(sessionId: string): Promise<any> {
    const query = `
      query ReactorGetChatSession($id: String!) {
        ReactorGetChatSession(id: $id) {
          id
          personaId
          history { role content }
        }
      }
    `;

    const result = await this.graphql(query, { id: sessionId });
    return result?.data?.ReactorGetChatSession;
  }

  async listChats(filter?: { personaId?: string }): Promise<any[]> {
    const query = `
      query ReactorListConversations($filter: ReactorConversationFilter) {
        ReactorListConversations(filter: $filter) {
          id
          personaId
          createdAt
          updatedAt
        }
      }
    `;

    const result = await this.graphql(query, { filter });
    return result?.data?.ReactorListConversations || [];
  }

  async deleteChat(sessionId: string): Promise<boolean> {
    const mutation = `
      mutation ReactorDeleteChat($id: String!) {
        ReactorDeleteChat(id: $id)
      }
    `;

    const result = await this.graphql(mutation, { id: sessionId });
    return result?.data?.ReactorDeleteChat === true;
  }

  async setToolApprovalMode(
    sessionId: string,
    mode: ToolApprovalMode
  ): Promise<void> {
    const mutation = `
      mutation ReactorSetToolApprovalMode($sessionId: String!, $mode: String!) {
        ReactorSetToolApprovalMode(sessionId: $sessionId, mode: $mode)
      }
    `;
    await this.graphql(mutation, { sessionId, mode });
  }

  async setMaxToolIterations(
    sessionId: string,
    count: number
  ): Promise<void> {
    const mutation = `
      mutation ReactorSetMaxToolIterations($sessionId: String!, $count: Int!) {
        ReactorSetMaxToolIterations(sessionId: $sessionId, count: $count)
      }
    `;
    await this.graphql(mutation, { sessionId, count });
  }

  async continueToolExecution(
    sessionId: string,
    personaId: string,
    maxIterations?: number
  ): Promise<any> {
    const mutation = `
      mutation ReactorContinueTools($sessionId: String!, $personaId: String!, $maxIterations: Int) {
        ReactorContinueToolExecution(
          sessionId: $sessionId,
          personaId: $personaId,
          maxIterations: $maxIterations
        ) {
          __typename
          ... on ReactorInitiateSSE {
            sessionId
            endpoint
            token
          }
          ... on ReactorErrorResponse {
            code
            message
          }
        }
      }
    `;

    const result = await this.graphql(mutation, {
      sessionId,
      personaId,
      maxIterations,
    });

    const response = result?.data?.ReactorContinueToolExecution;
    if (response?.__typename === "ReactorInitiateSSE") {
      await this.connectSSE(
        response.endpoint,
        response.sessionId,
        response.token,
        sessionId
      );
    }

    return response;
  }

  async setModelProvider(
    sessionId: string,
    modelId?: string,
    providerId?: string
  ): Promise<void> {
    const mutation = `
      mutation ReactorSetModelProvider($sessionId: String!, $modelId: String, $providerId: String) {
        ReactorSetChatModelProvider(sessionId: $sessionId, modelId: $modelId, providerId: $providerId)
      }
    `;
    await this.graphql(mutation, { sessionId, modelId, providerId });
  }

  async uploadFile(filePath: string, sessionId: string): Promise<any> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }
    // For HTTP transport, convert file to base64 and send as image
    // (full multipart upload support may be added later)
    const base64 = await this.fileToBase64DataUrl(absPath);
    return { filename: path.basename(absPath), data: base64 };
  }

  async executeMacro(
    macro: string,
    personaId: string,
    sessionId: string,
    args?: any
  ): Promise<any> {
    const mutation = `
      mutation ReactorExecuteMacro($input: ReactorMacroInput!) {
        ReactorExecuteMacro(input: $input) {
          __typename
          ... on ReactorInitiateSSE { sessionId endpoint token }
          ... on ReactorChatMessage { id content role }
          ... on ReactorErrorResponse { code message }
        }
      }
    `;
    const result = await this.graphql(mutation, {
      input: { macro, personaId, chatSessionId: sessionId, args },
    });
    return result?.data?.ReactorExecuteMacro;
  }

  disconnect(): void {
    if (this.activeEventSource) {
      this.activeEventSource.destroy();
      this.activeEventSource = null;
    }
    this.removeAllListeners();
  }

  // ── SSE Connection ─────────────────────────────────────────────────

  private async connectSSE(
    endpoint: string,
    sseSessionId: string,
    token: string | null,
    conversationId: string
  ): Promise<void> {
    // Close any existing SSE connection
    if (this.activeEventSource) {
      this.activeEventSource.destroy();
      this.activeEventSource = null;
    }

    const url = new URL(endpoint, this.options.apiUrl);
    const isSecure = url.protocol === "https:";
    const httpModule = isSecure ? https : http;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Authorization: `Bearer ${this.options.authToken}`,
    };

    if (token) {
      headers["x-streaming-token"] = token;
    }
    if (this.options.clientKey) {
      headers["x-client-key"] = this.options.clientKey;
    }

    return new Promise((resolve, reject) => {
      const req = httpModule.get(
        url.toString(),
        { headers },
        (res) => {
          if (res.statusCode !== 200) {
            reject(
              new Error(`SSE connection failed: HTTP ${res.statusCode}`)
            );
            return;
          }

          this.activeEventSource = res;
          this.reconnectAttempts = 0;
          let buffer = "";

          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete last line

            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData += line.slice(6);
              } else if (line === "" && eventData) {
                // End of event block
                this.handleSSEEvent(
                  eventType,
                  eventData,
                  sseSessionId,
                  conversationId
                );
                eventType = "";
                eventData = "";
              }
            }
          });

          res.on("end", () => {
            this.activeEventSource = null;
          });

          res.on("error", (err: Error) => {
            this.emit("event", {
              type: StreamingEventType.ERROR,
              sessionId: sseSessionId,
              conversationId,
              messageId: "",
              timestamp: new Date(),
              data: { message: err.message },
            });
            this.activeEventSource = null;
          });

          resolve();
        }
      );

      req.on("error", (err) => {
        reject(err);
      });
    });
  }

  private handleSSEEvent(
    eventType: string,
    rawData: string,
    sseSessionId: string,
    conversationId: string
  ): void {
    try {
      const parsed = JSON.parse(rawData);
      const event = {
        type: parsed.type || eventType,
        sessionId: parsed.sessionId || sseSessionId,
        conversationId: parsed.conversationId || conversationId,
        messageId: parsed.messageId || "",
        timestamp: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
        data: parsed.data || parsed,
      };

      this.emit("event", event);
    } catch {
      logger.warn(`Failed to parse SSE event data: ${rawData.substring(0, 100)}`);
    }
  }

  // ── GraphQL Helper ─────────────────────────────────────────────────

  private async graphql(
    query: string,
    variables?: Record<string, any>
  ): Promise<any> {
    const url = new URL("/api", this.options.apiUrl);
    const body = JSON.stringify({ query, variables });
    const isSecure = url.protocol === "https:";
    const httpModule = isSecure ? https : http;

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        url.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.authToken}`,
            ...(this.options.clientKey
              ? { "x-client-key": this.options.clientKey }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
            }
          });
        }
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // ── File Helpers ───────────────────────────────────────────────────

  private async fileToBase64DataUrl(filePath: string): Promise<string> {
    const absPath = path.resolve(filePath);
    const buffer = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }
}
