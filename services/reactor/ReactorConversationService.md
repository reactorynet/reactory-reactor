# ReactorConversationService

The `ReactorConversationService` is responsible for managing chat conversations between users and AI personas in the Reactory platform. It handles the creation, retrieval, updating, and deletion of chat sessions, as well as sending messages, executing macros/tools, and attaching images.

## Key Responsibilities

- Manage chat sessions and conversation history
- Interface with AI providers (OpenAI, xAI, etc.)
- Support macros and tools for enhanced interactions
- Attach images and process them with AI models
- Provide error handling and response adaptation

## Class Diagram

```mermaid
classDiagram
    class ReactorConversationService {
        - context: IReactoryContext
        - openaiService: IOpenAIService
        - providerService: IReactorProviderService
        - personaProvider: AIPersonaProvider
        - messageProcessingService: ReactorMessageProcessingService
        + getConversations(filter): Promise
        + getChatSession(args): Promise
        + sendMessage(args): Promise
        + executeMacro(args): Promise
        + executeTool(args): Promise
        + attachImage(args): Promise
        + deleteChatSession(args): Promise
        + startChatSession(args): Promise
    }
    ReactorConversationService --> IOpenAIService
    ReactorConversationService --> IReactorProviderService
    ReactorConversationService --> AIPersonaProvider
    ReactorConversationService --> ReactorMessageProcessingService
    ReactorConversationService --> ReactorConversationModel
```

## Conversation Control Flow

```mermaid
flowchart TD
    A[User sends message] --> B[sendMessage]
    B --> C[Get Persona & Provider]
    C --> D{Existing Chat Session?}
    D -- Yes --> E[Load Conversation]
    D -- No --> F[Create New Conversation]
    E & F --> G[Add User Message to History]
    G --> H[Get Provider Adapter]
    H --> I[Send Message to AI Provider]
    I --> J{AI Response?}
    J -- Yes --> K[Add AI Response to History]
    J -- No --> L[Add System Message: No Response]
    K & L --> M[Save Conversation]
    M --> N[Adapt and Return Response]
```

## Example Usage

```typescript
const service = new ReactorConversationService(props, context);
const response = await service.sendMessage({
  personaId: "persona123",
  chatSessionId: "session456",
  message: "Hello, AI!"
});
```

## See Also

- [ReactorConversationModel](../models/ReactorChatState.ts)
- [AIPersonaProvider](./AIPersonaProvider.ts)
- [IOpenAIService](../../types/service.types.ts)
