# ReactorConversationService

The `ReactorConversationService` is the core service responsible for managing AI-powered chat conversations in the Reactory platform. It orchestrates interactions between users and AI personas, handling the complete conversation lifecycle from creation to message processing, with advanced features like token management, error recovery, and tool execution.

## Overview

This service acts as the central orchestrator for AI conversations, providing:
- **Conversation Management**: Create, retrieve, update, and manage chat sessions
- **Multi-Provider Support**: Interface with multiple AI providers (OpenAI, xAI, Google AI)
- **Token Management**: Atomic token counting, limits enforcement, and conversation truncation
- **Tool Execution**: Support for macros and tools with parallel/sequential execution modes
- **File Handling**: Attach images and files for AI processing
- **Error Recovery**: Comprehensive error handling with correlation tracking and retry mechanisms
- **Race Condition Prevention**: Atomic database operations to prevent data corruption

## Key Responsibilities

### Core Conversation Management
- **Session Lifecycle**: Create, load, update, and manage conversation states
- **History Management**: Maintain conversation history with truncation support for token limits
- **User Context**: Secure user-scoped conversation access and permissions

### AI Provider Integration
- **Multi-Provider Support**: OpenAI, xAI, Google AI with unified interface
- **Provider Adapters**: Normalize responses across different AI providers
- **Model Management**: Support different models per persona configuration

### Advanced Features
- **Token Management**: Real-time token counting, limit enforcement, and intelligent truncation
- **Tool Orchestration**: Execute macros and tools with dependency management
- **File Processing**: Attach and process images, documents with AI models
- **Error Recovery**: Structured error responses with correlation tracking
- **Race Condition Prevention**: Atomic database operations using MongoDB aggregation pipelines

## Architecture Overview

```mermaid
graph TB
    subgraph "Client Layer"
        UI[User Interface]
        ChatComponent[Chat Component]
    end
    
    subgraph "Service Layer"
        RCS[ReactorConversationService]
        AIP[AIPersonaProvider]
        RPS[ReactorProviderService]
        RMS[ReactorMessageProcessingService]
        RMacS[ReactorMacroService]
        DCS[DocumentChunkingService]
    end
    
    subgraph "Provider Layer"
        OAI[OpenAI Service]
        GAI[Google AI Service]
        XAI[xAI Service]
    end
    
    subgraph "Data Layer"
        RCM[(ReactorConversationModel)]
        MongoDB[(MongoDB)]
    end
    
    subgraph "External Services"
        OpenAI[OpenAI API]
        Google[Google AI API]
        xAI[xAI API]
    end
    
    UI --> ChatComponent
    ChatComponent --> RCS
    RCS --> AIP
    RCS --> RPS
    RCS --> RMS
    RCS --> RMacS
    RCS --> DCS
    RCS --> RCM
    RCM --> MongoDB
    
    RPS --> OAI
    RPS --> GAI
    RPS --> XAI
    
    OAI --> OpenAI
    GAI --> Google
    XAI --> xAI
    
    style RCS fill:#e1f5fe
    style MongoDB fill:#f3e5f5
    style OpenAI fill:#fff3e0
    style Google fill:#e8f5e8
    style xAI fill:#fce4ec
```

## Class Relationships

```mermaid
classDiagram
    class ReactorConversationService {
        -context: IReactoryContext
        -openaiService: IOpenAIService
        -googleAIService: GoogleAIService
        -providerService: IReactorProviderService
        -personaProvider: AIPersonaProvider
        -messageProcessingService: ReactorMessageProcessingService
        -macroService: ReactorMacroService
        -chunkingService: DocumentChunkingService
        -fileService: IReactoryFileService
        
        +getConversations(filter): Promise~TReactorConversationDocument[]~
        +getChatSession(args): Promise~TReactorConversationDocument~
        +sendMessage(args): Promise~any~
        +executeMacro(args): Promise~any~
        +executeTool(args): Promise~any~
        +attachImage(args): Promise~any~
        +attachFiles(args): Promise~any~
        +setChatMaxTokens(chatSessionId, maxTokens): Promise~any~
        +getChatTokenCount(chatSessionId): Promise~TokenStatus~
        +getFullConversationHistory(chatSessionId): Promise~HistoryData~
        +clearTruncatedHistory(chatSessionId): Promise~ClearResult~
        
        -updateConversationTokenCount(conversationId): Promise~number~
        -updateTokenCountAndCheckLimits(conversationId): Promise~TokenLimits~
        -truncateConversationHistory(conversationId, targetTokens): Promise~TruncateResult~
        -createErrorResponse(code, message, options): ReactorErrorResponse
        -handleError(error, operation, conversationId): ReactorErrorResponse
        -validateConversationDocument(conversation, operation, context): void
        -getNewConversation(persona): Promise~TReactorConversationDocument~
    }
    
    class ReactorConversationModel {
        +_id: ObjectId
        +user: ObjectId
        +personaId: string
        +history: ReactorConversationHistoryItem[]
        +truncatedHistory: ReactorConversationHistoryItem[]
        +tokenCount: number
        +maxTokens: number
        +toolApprovalMode: ToolApprovalMode
        +started: Date
        +updated: Date
    }
    
    class AIPersonaProvider {
        +getPersona(personaId): Promise~IAIPersona~
    }
    
    class ReactorProviderService {
        +getAdapter(provider): Promise~IProviderAdapter~
    }
    
    class DocumentChunkingService {
        +estimateTokenCount(text): number
    }
    
    ReactorConversationService --> ReactorConversationModel
    ReactorConversationService --> AIPersonaProvider
    ReactorConversationService --> ReactorProviderService
    ReactorConversationService --> DocumentChunkingService
    ReactorConversationService --> ReactorMacroService
    ReactorConversationService --> ReactorMessageProcessingService
```

## Message Flow and State Management

### Complete Conversation Flow
```mermaid
flowchart TD
    A[User sends message] --> B{Existing Chat Session?}
    B -- No --> C[Create New Conversation]
    B -- Yes --> D[Load Existing Conversation]
    
    C --> E[Initialize with Persona]
    D --> F[Validate User Permissions]
    E --> G[Add User Message to History]
    F --> G
    
    G --> H[Update Token Count Atomically]
    H --> I{Token Limit Exceeded?}
    I -- Yes --> J[Truncate History]
    I -- No --> K[Get AI Provider]
    J --> K
    
    K --> L[Send to AI Provider]
    L --> M{AI Response Type?}
    
    M -- Text Only --> N[Add AI Response to History]
    M -- Tool Calls --> O[Process Tool Calls]
    M -- Error --> P[Handle Provider Error]
    
    O --> Q{Tool Approval Mode?}
    Q -- PROMPT --> R[Request User Approval]
    Q -- AUTO --> S[Execute Tools Automatically]
    
    R --> T[User Approves/Denies]
    T --> U{Approved?}
    U -- Yes --> S
    U -- No --> V[Cancel Tool Execution]
    
    S --> W[Execute Tools]
    W --> X{Tool Results?}
    X -- Success --> Y[Add Tool Results to History]
    X -- Error --> Z[Handle Tool Errors]
    
    Y --> AA[Send Results to AI]
    Z --> AA
    AA --> BB[AI Processes Tool Results]
    BB --> N
    
    N --> CC[Update Conversation State]
    P --> DD[Create Error Response]
    V --> EE[Create Cancellation Response]
    CC --> FF[Return Response to Client]
    DD --> FF
    EE --> FF
    
    style A fill:#e3f2fd
    style FF fill:#e8f5e8
    style P fill:#ffebee
    style Z fill:#ffebee
```

### Token Management Flow
```mermaid
flowchart TD
    A[Message Added to History] --> B[Trigger Token Count Update]
    B --> C[Use MongoDB Aggregation Pipeline]
    C --> D[Calculate Total Tokens Atomically]
    D --> E[Update Conversation Document]
    E --> F{Exceeds Max Tokens?}
    
    F -- No --> G[Continue Normal Flow]
    F -- Yes --> H{Exceeds by 20%?}
    
    H -- No --> I[Log Warning]
    H -- Yes --> J[Trigger Truncation]
    
    I --> G
    J --> K[Preserve System Messages]
    K --> L[Keep Recent Messages]
    L --> M[Move Old Messages to Truncated History]
    M --> N[Update Conversation with New History]
    N --> O[Log Truncation Details]
    O --> G
    
    style A fill:#e3f2fd
    style G fill:#e8f5e8
    style J fill:#fff3e0
    style O fill:#f3e5f5
```

### Error Handling State Machine
```mermaid
stateDiagram-v2
    [*] --> Normal: Operation Start
    
    Normal --> Validating: Input Received
    Validating --> Processing: Valid Input
    Validating --> ValidationError: Invalid Input
    
    Processing --> Success: Operation Complete
    Processing --> RetryableError: Temporary Failure
    Processing --> NonRetryableError: Permanent Failure
    
    RetryableError --> Processing: Retry Attempt
    RetryableError --> MaxRetriesReached: All Retries Failed
    
    ValidationError --> ErrorResponse: Create Error Response
    NonRetryableError --> ErrorResponse: Create Error Response
    MaxRetriesReached --> ErrorResponse: Create Error Response
    
    Success --> [*]: Return Result
    ErrorResponse --> [*]: Return Error
    
    note right of RetryableError
        Examples:
        - Network timeouts
        - Rate limits
        - Temporary service unavailability
    end note
    
    note right of NonRetryableError
        Examples:
        - Permission denied
        - Resource not found
        - Invalid configuration
    end note
```

## Implementation Status

### ✅ Completed Features

#### Race Condition Prevention (Priority 1)
- **Atomic Token Counting**: MongoDB aggregation pipelines for atomic token calculations
- **Consolidated Database Operations**: Single findOneAndUpdate operations instead of find+update
- **Atomic Message History Updates**: Prevents duplicate messages and lost updates
- **Race-Free Conversation Creation**: Single create operation with pre-set IDs

#### Error Handling & Reliability (Priority 2) 
- **Structured Error Responses**: ReactorErrorResponse interface with correlation tracking
- **Error Classification**: Comprehensive error categorization (validation, permission, resource, etc.)
- **Correlation IDs**: UUID-based error tracking for debugging across service boundaries
- **Retry Logic**: Configurable retry mechanisms for transient failures
- **Graceful Degradation**: Continue processing when possible, fail gracefully when not

#### Documentation & Code Quality (Priority 3)
- **Comprehensive JSDoc**: Detailed documentation for all public methods with examples
- **Business Logic Constants**: Named constants for magic numbers and thresholds
- **Inline Comments**: Detailed comments explaining complex business logic
- **Mermaid Diagrams**: Architecture, flow, and state diagrams for visual understanding
- **Usage Examples**: Practical examples for common use cases

### 🔄 In Progress

#### Type Safety Improvements (Priority 4)
- **TypeScript Warnings**: Some @ts-ignore comments and type mismatches remain
- **Interface Completeness**: Some method parameters need proper interface definitions
- **Generic Type Safety**: More specific typing for provider responses

### 📋 Pending Items (Priority 5)

#### Performance Optimizations
- **Database Query Optimization**: Review and optimize aggregation pipelines
- **Connection Pooling**: Implement connection pooling strategies
- **Bulk Operations**: Reduce database roundtrips where possible
- **Caching Strategy**: Implement caching for frequently accessed data

#### Advanced Features
- **Tool Dependency Management**: Define and manage tool execution dependencies
- **Enhanced Metrics**: More detailed performance and usage metrics
- **Circuit Breaker Pattern**: Prevent cascading failures in tool execution

## Example Usage

### **Basic Tool Execution**
```typescript
const service = new ReactorConversationService(props, context);
const response = await service.sendMessage({
  personaId: "persona123",
  chatSessionId: "session456",
  message: "Hello, AI!"
});
```

### **Multiple Tool Processing**
```typescript
const toolResults = await service.processToolCalls({
  toolCalls: [
    { function: { name: "search_database", arguments: { query: "users" } } },
    { function: { name: "send_email", arguments: { to: "user@example.com" } } }
  ],
  personaId: "persona123",
  chatSessionId: "session456",
  executionMode: "parallel",
  maxRetries: 3
});
```

## See Also

- [ReactorConversationModel](../models/ReactorChatState.ts)
- [AIPersonaProvider](./AIPersonaProvider.ts)
- [ReactorMessageProcessingService](./ReactorMessageProcessingService.ts)
- [IOpenAIService](../../types/service.types.ts)
- [Streaming Implementation Plan](./ReactorConversationService-StreamingPlan.md) - **Comprehensive plan for adding real-time streaming support**

## Future Roadmap

### 🚀 Streaming Support (In Planning)
A comprehensive plan has been developed to add real-time streaming capabilities while maintaining full backward compatibility with the existing GraphQL API. See the [Streaming Implementation Plan](./ReactorConversationService-StreamingPlan.md) for detailed architecture and implementation strategy.

**Key Features:**
- **Hybrid Architecture**: Support both stateless GraphQL and stateful streaming
- **Progressive Enhancement**: Opt-in streaming with automatic fallback
- **Real-time Experience**: Token-by-token streaming from AI providers
- **Multiple Transports**: SSE and WebSocket support
- **Session Management**: Redis-backed session persistence
- **Performance Optimized**: Adaptive buffering and intelligent batching
