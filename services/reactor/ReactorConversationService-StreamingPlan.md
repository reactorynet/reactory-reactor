# Streaming Implementation Plan for ReactorConversationService

## Current State Analysis

### ✅ Existing Infrastructure
The codebase already has significant streaming infrastructure in place:

1. **MCP (Model Context Protocol) SDK**: Full SSE and WebSocket support
2. **SSE Transport**: Server-Sent Events implementation in `mcpsdk/src/server/sse.ts`
3. **GraphQL Schema**: Already defines `ReactorInitiateSSE` type in schema
4. **Middleware**: MCP servers with SSE handling in `middleware/mcp/ReactorServer.ts`
5. **AMQ System**: Postal.js-based pub/sub for internal message routing

### 🔄 Current Limitations
1. **GraphQL Stateless**: Each request is independent, no session persistence
2. **No Streaming in ConversationService**: Currently returns complete responses
3. **Token Streaming**: AI providers support streaming but service doesn't utilize it
4. **Client Experience**: Long waits for complex responses, no real-time feedback

## Implementation Strategy: Hybrid Architecture

### 🎯 Design Goals
1. **Backward Compatibility**: Maintain existing GraphQL API unchanged
2. **Progressive Enhancement**: Add streaming as an optional feature
3. **Session Management**: Bridge stateless GraphQL with stateful streaming
4. **Real-time Experience**: Enable token-by-token streaming from AI providers

### 🏗️ Architecture Overview

```mermaid
graph TB
    subgraph "Client Layer"
        GQL[GraphQL Client]
        SSE[SSE Client] 
        WS[WebSocket Client]
    end
    
    subgraph "API Layer"
        GQLAPI[GraphQL API]
        SSEAPI[SSE Endpoints]
        WSAPI[WebSocket Endpoints]
    end
    
    subgraph "Service Layer - Enhanced"
        RCS[ReactorConversationService]
        SCS[StreamingConversationService]
        SSM[StreamingSessionManager]
    end
    
    subgraph "Provider Layer - Enhanced" 
        OAI[OpenAI Service - Streaming]
        GAI[Google AI Service - Streaming]
        XAI[xAI Service - Streaming]
    end
    
    subgraph "Session Storage"
        Redis[(Redis Sessions)]
        Memory[(In-Memory Sessions)]
    end
    
    GQL --> GQLAPI
    SSE --> SSEAPI
    WS --> WSAPI
    
    GQLAPI --> RCS
    SSEAPI --> SCS
    WSAPI --> SCS
    
    SCS --> SSM
    SCS --> RCS
    SSM --> Redis
    SSM --> Memory
    
    RCS --> OAI
    SCS --> OAI
    RCS --> GAI  
    SCS --> GAI
    RCS --> XAI
    SCS --> XAI
    
    style SCS fill:#e1f5fe
    style SSM fill:#f3e5f5
    style Redis fill:#ffecb3
```

## Implementation Plan

### Phase 1: Core Streaming Infrastructure (Week 1-2)

#### 1.1 StreamingConversationService
```typescript
/**
 * Enhanced conversation service with streaming capabilities
 * Extends existing ReactorConversationService with real-time features
 */
@service({
  id: "reactor.StreamingConversationService@1.0.0",
  extends: "reactor.ReactorConversationService@1.0.0"
})
export class StreamingConversationService extends ReactorConversationService {
  
  /**
   * Send message with streaming response support
   * Returns either immediate response or streaming session info
   */
  async sendMessageWithStreaming(args: {
    personaId: string;
    chatSessionId?: string;
    message: string;
    streamingMode: 'none' | 'sse' | 'websocket';
    clientCapabilities?: StreamingClientCapabilities;
  }): Promise<ReactorChatResponse | ReactorInitiateSSE>;
  
  /**
   * Process streaming response from AI provider
   * Handles token-by-token streaming and session management
   */
  async processStreamingResponse(
    streamingSession: StreamingSession,
    aiResponse: ReadableStream<any>
  ): Promise<void>;
}
```

#### 1.2 StreamingSessionManager
```typescript
/**
 * Manages streaming sessions with Redis/Memory backend
 * Handles session lifecycle, cleanup, and state synchronization
 */
export class StreamingSessionManager {
  
  /**
   * Create new streaming session
   */
  async createSession(args: {
    conversationId: string;
    userId: string;
    transport: 'sse' | 'websocket';
    capabilities: StreamingClientCapabilities;
  }): Promise<StreamingSession>;
  
  /**
   * Get active streaming session
   */
  async getSession(sessionId: string): Promise<StreamingSession | null>;
  
  /**
   * Update session state atomically
   */
  async updateSession(sessionId: string, updates: Partial<StreamingSession>): Promise<void>;
  
  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<number>;
}
```

#### 1.3 Enhanced GraphQL Schema
```graphql
# Add to existing schema
extend type Mutation {
  """
  Send message with optional streaming support
  Returns either direct response or streaming session info
  """
  sendMessageStreaming(
    personaId: String!
    chatSessionId: String
    message: String!
    streamingMode: StreamingMode = NONE
    clientCapabilities: StreamingClientCapabilitiesInput
  ): ReactorChatResponse!
}

enum StreamingMode {
  NONE
  SSE  
  WEBSOCKET
}

input StreamingClientCapabilitiesInput {
  supportsTokenStreaming: Boolean!
  supportsToolStreaming: Boolean!
  bufferSize: Int
  timeoutMs: Int
}

# Already exists in schema
type ReactorInitiateSSE {
  sessionId: String!
  endpoint: String!
  token: String
  status: String
  expiry: Date
  headers: Any
}
```

### Phase 2: AI Provider Streaming Integration (Week 2-3)

#### 2.1 Enhanced Provider Services
```typescript
/**
 * OpenAI Service with streaming support
 */
export class OpenAIStreamingService extends OpenAIService {
  
  /**
   * Chat with streaming response
   */
  async chatStream(args: ChatStreamArgs): Promise<{
    stream: ReadableStream<OpenAI.Chat.Completions.ChatCompletionChunk>;
    sessionId: string;
  }>;
  
  /**
   * Process streaming chunks and emit events
   */
  async processStreamingChunks(
    stream: ReadableStream,
    sessionManager: StreamingSessionManager,
    sessionId: string
  ): Promise<void>;
}
```

#### 2.2 Streaming Event Types
```typescript
interface StreamingEvent {
  type: 'token' | 'tool_call' | 'complete' | 'error';
  sessionId: string;
  conversationId: string;
  timestamp: Date;
  data: any;
}

interface TokenStreamingEvent extends StreamingEvent {
  type: 'token';
  data: {
    content: string;
    delta: string;
    position: number;
    isComplete: boolean;
  };
}

interface ToolCallStreamingEvent extends StreamingEvent {
  type: 'tool_call';
  data: {
    toolName: string;
    arguments: any;
    callId: string;
    status: 'started' | 'progress' | 'completed' | 'error';
  };
}
```

### Phase 3: Transport Layer Implementation (Week 3-4)

#### 3.1 SSE Streaming Endpoints
```typescript
/**
 * SSE endpoints for streaming conversations
 */
app.get('/api/reactor/stream/:sessionId', async (req, res) => {
  const streamingService = context.getService<StreamingConversationService>();
  const session = await streamingService.getStreamingSession(req.params.sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Setup SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Create SSE transport and connect to session
  const transport = new SSEServerTransport('/api/reactor/stream/message', res);
  await streamingService.connectTransport(session.sessionId, transport);
});

app.post('/api/reactor/stream/message', async (req, res) => {
  // Handle incoming messages from SSE clients
  const sessionId = req.query.sessionId as string;
  const streamingService = context.getService<StreamingConversationService>();
  await streamingService.handleStreamingMessage(sessionId, req.body);
  res.json({ status: 'received' });
});
```

#### 3.2 WebSocket Streaming Endpoints
```typescript
/**
 * WebSocket server for real-time streaming
 */
const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', async (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  
  if (!sessionId) {
    ws.close(1008, 'Missing sessionId');
    return;
  }
  
  const streamingService = context.getService<StreamingConversationService>();
  const transport = new WebSocketServerTransport(ws);
  await streamingService.connectTransport(sessionId, transport);
});
```

### Phase 4: Client-Side Integration (Week 4-5)

#### 4.1 GraphQL with Streaming Fallback
```typescript
/**
 * Enhanced GraphQL client with streaming support
 */
export class ReactorChatClient {
  
  /**
   * Send message with automatic streaming detection
   */
  async sendMessage(args: SendMessageArgs): Promise<ChatResponse> {
    // Try GraphQL first for simple requests
    if (!this.shouldUseStreaming(args)) {
      return this.sendMessageGraphQL(args);
    }
    
    // Use streaming for complex requests
    return this.sendMessageStreaming(args);
  }
  
  /**
   * Determine if streaming should be used
   */
  private shouldUseStreaming(args: SendMessageArgs): boolean {
    return (
      args.expectLongResponse ||
      args.toolsRequired ||
      args.preferRealTime ||
      this.config.alwaysStream
    );
  }
  
  /**
   * Handle streaming response
   */
  private async sendMessageStreaming(args: SendMessageArgs): Promise<ChatResponse> {
    // 1. Initiate streaming session via GraphQL
    const initResponse = await this.graphql.mutate({
      mutation: SEND_MESSAGE_STREAMING,
      variables: { ...args, streamingMode: 'SSE' }
    });
    
    if (initResponse.data.__typename === 'ReactorInitiateSSE') {
      // 2. Connect to SSE endpoint
      const eventSource = new EventSource(initResponse.data.endpoint);
      
      // 3. Handle streaming events
      return this.handleStreamingEvents(eventSource, initResponse.data.sessionId);
    }
    
    // Fallback to direct response
    return initResponse.data;
  }
}
```

#### 4.2 React Hooks for Streaming
```typescript
/**
 * React hook for streaming conversations
 */
export function useStreamingChat(personaId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamingMessage, setCurrentStreamingMessage] = useState<string>('');
  
  const sendMessage = useCallback(async (content: string) => {
    setIsStreaming(true);
    
    const client = new ReactorChatClient();
    const response = await client.sendMessage({
      personaId,
      message: content,
      onToken: (token) => {
        setCurrentStreamingMessage(prev => prev + token);
      },
      onComplete: (completeMessage) => {
        setMessages(prev => [...prev, completeMessage]);
        setCurrentStreamingMessage('');
        setIsStreaming(false);
      },
      onError: (error) => {
        console.error('Streaming error:', error);
        setIsStreaming(false);
      }
    });
  }, [personaId]);
  
  return {
    messages,
    sendMessage,
    isStreaming,
    currentStreamingMessage
  };
}
```

## Implementation Details

### 🔧 Technical Considerations

#### Session Management
```typescript
interface StreamingSession {
  sessionId: string;
  conversationId: string;
  userId: string;
  transport: 'sse' | 'websocket';
  status: 'active' | 'paused' | 'completed' | 'error';
  createdAt: Date;
  lastActivity: Date;
  expiresAt: Date;
  
  // Streaming state
  currentMessage?: {
    id: string;
    content: string;
    isComplete: boolean;
    tokens: StreamingToken[];
  };
  
  // Tool execution state
  activeTool?: {
    name: string;
    callId: string;
    status: 'running' | 'completed' | 'error';
    result?: any;
  };
  
  // Client capabilities
  capabilities: StreamingClientCapabilities;
}
```

#### Error Handling and Recovery
```typescript
/**
 * Streaming-specific error handling
 */
export class StreamingErrorHandler {
  
  /**
   * Handle streaming errors with graceful degradation
   */
  async handleStreamingError(
    session: StreamingSession,
    error: Error,
    context: string
  ): Promise<StreamingErrorResponse> {
    
    // Log error with correlation
    const correlationId = v4();
    logger.error('Streaming error', { 
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      error: error.message,
      context,
      correlationId 
    });
    
    // Attempt recovery based on error type
    if (this.isRetryableError(error)) {
      return this.retryOperation(session, context);
    }
    
    // Fallback to non-streaming mode
    if (this.canFallbackToSync(session)) {
      return this.fallbackToSyncMode(session);
    }
    
    // Terminal error - cleanup session
    await this.cleanupSession(session.sessionId);
    
    return {
      __typename: 'ReactorErrorResponse',
      code: 'STREAMING_ERROR',
      message: 'Streaming session failed',
      correlationId,
      recoverable: false,
      suggestion: 'Please try again with a new session'
    };
  }
}
```

#### Performance Optimizations
```typescript
/**
 * Performance optimizations for streaming
 */
export class StreamingOptimizer {
  
  /**
   * Adaptive buffering based on client capabilities
   */
  getOptimalBufferSize(capabilities: StreamingClientCapabilities): number {
    const baseSize = capabilities.bufferSize || 1024;
    const networkLatency = this.estimateNetworkLatency();
    
    // Adjust buffer size based on network conditions
    if (networkLatency > 200) return baseSize * 2;
    if (networkLatency < 50) return Math.max(baseSize / 2, 256);
    return baseSize;
  }
  
  /**
   * Token batching for efficient streaming
   */
  async batchTokens(tokens: string[], batchSize: number): Promise<string[]> {
    const batches: string[] = [];
    
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize).join('');
      batches.push(batch);
    }
    
    return batches;
  }
}
```

## Migration Strategy

### 🔄 Backward Compatibility
1. **Existing API Unchanged**: All current GraphQL mutations/queries work exactly as before
2. **Opt-in Streaming**: Clients explicitly request streaming via `streamingMode` parameter
3. **Feature Detection**: Clients can detect streaming support via schema introspection
4. **Graceful Degradation**: Streaming failures automatically fallback to synchronous mode

### 📈 Progressive Rollout
1. **Phase 1**: Internal testing with feature flags
2. **Phase 2**: Beta release to select users
3. **Phase 3**: Gradual rollout with monitoring
4. **Phase 4**: Full deployment with streaming as default for supported clients

### 🎯 Success Metrics
- **Response Time**: Perception of faster responses due to streaming
- **User Engagement**: Increased interaction with real-time feedback
- **Error Rates**: Maintain < 0.1% error rate for streaming sessions
- **Resource Usage**: Monitor memory/CPU impact of persistent connections

## Benefits

### ✅ User Experience
- **Real-time Feedback**: See responses as they're generated
- **Reduced Perceived Latency**: Start reading while AI is still generating
- **Tool Execution Visibility**: Watch tools execute in real-time
- **Better Error Handling**: Immediate feedback on issues

### ✅ Technical Benefits
- **Resource Efficiency**: Stream tokens instead of buffering entire responses
- **Scalability**: Handle more concurrent conversations with streaming
- **Flexibility**: Support both streaming and traditional clients
- **Monitoring**: Better observability into conversation performance

### ✅ Business Value
- **Competitive Advantage**: Modern chat experience
- **User Retention**: Improved UX leads to higher engagement
- **Cost Optimization**: More efficient resource utilization
- **Future-Proof**: Foundation for advanced features (collaborative editing, multi-user chats)

## Implementation Timeline

- **Week 1-2**: Core streaming infrastructure and session management
- **Week 3-4**: AI provider streaming integration and transport layer
- **Week 4-5**: Client-side implementation and React hooks
- **Week 6**: Testing, optimization, and documentation
- **Week 7-8**: Beta deployment and monitoring
- **Week 9-10**: Full rollout and performance tuning

This plan maintains complete backward compatibility while adding powerful streaming capabilities that will significantly improve the user experience.
