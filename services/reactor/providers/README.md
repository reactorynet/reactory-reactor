# AI Provider Services

This directory contains implementations of various AI provider services for the Reactory Reactor module. Each service extends `AIProviderBase` and implements the specific API requirements for their respective AI providers.

## Implemented Providers

### 1. GoogleAIService
- **Provider**: Google AI (Gemini)
- **Package**: `@google/genai`
- **Key Features**:
  - Full streaming support (SSE)
  - Tool/function calling support
  - Comprehensive error handling with retry logic
  - Advanced message formatting for Gemini compatibility
  - Tool result handling

### 2. AWSBedrockService
- **Provider**: AWS Bedrock (Claude, Llama, etc.)
- **Package**: `@aws-sdk/client-bedrock-runtime`
- **Key Features**:
  - Token streaming support via `InvokeModelWithResponseStreamCommand`
  - Limited tool streaming (converted to user messages)
  - AWS credential management
  - Anthropic Claude model compatibility
  - Message format conversion for Bedrock API

### 3. AnthropicService
- **Provider**: Anthropic Claude
- **Package**: `@anthropic-ai/sdk`
- **Key Features**:
  - Full streaming support
  - Native tool/function calling
  - Direct Claude API integration
  - Message format conversion for Anthropic API
  - Comprehensive error handling

## Key Differences and Nuances

### Message Format Handling

#### Google AI (Gemini)
- Uses "parts" format with `text` and `functionCall` objects
- Supports system instructions in chat session config
- Tool calls are embedded in content parts

#### AWS Bedrock
- Uses Anthropic-compatible message format
- System prompts are passed as separate parameters
- Tool calls use `tool_use` and `tool_result` content blocks
- Requires message format conversion from OpenAI-style

#### Anthropic
- Native message format with `tool_use` and `tool_result`
- System prompts are separate parameters
- Direct API integration without format conversion

### Streaming Capabilities

| Provider | Token Streaming | Tool Streaming | Function Streaming | Notes |
|----------|----------------|----------------|-------------------|-------|
| Google AI | ✅ | ✅ | ✅ | Full streaming support |
| AWS Bedrock | ✅ | ❌ | ❌ | Limited to token streaming |
| Anthropic | ✅ | ✅ | ✅ | Full streaming support |

### Tool/Function Calling

#### Google AI
- Comprehensive tool call support
- Tool results integrated into conversation flow
- Automatic retry for tool-related errors

#### AWS Bedrock
- Tool calls converted to user messages
- Limited tool streaming support
- Requires manual message format conversion

#### Anthropic
- Native tool calling support
- Tool results handled via content blocks
- Direct API integration

### Error Handling

All providers implement:
- Retry logic for transient errors
- Graceful error responses
- Comprehensive logging
- Error categorization (retryable vs. non-retryable)

### Configuration

#### Environment Variables
- **Google AI**: `GOOGLE_AI_API_KEY`, `GOOGLE_AI_PROJECT_ID`, `GOOGLE_AI_MODEL_ID`
- **AWS Bedrock**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_BEDROCK_MODEL_ID`
- **Anthropic**: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_ID`

#### Persona Configuration
Each provider supports persona-specific configuration:
- API keys
- Model IDs
- Model configuration (temperature, maxTokens, etc.)
- Custom endpoint URLs

## Usage

### Basic Chat
```typescript
const service = new GoogleAIService(props, context);
const response = await service.chat({
  personaId: "persona-id",
  message: "Hello, how are you?",
  streamingMode: StreamingMode.SSE
});
```

### Streaming Chat
```typescript
const response = await service.chat({
  personaId: "persona-id",
  message: "Tell me a story",
  streamingMode: StreamingMode.SSE
});
```

### Tool Execution
```typescript
// Tool results are automatically handled by the service
const response = await service.chat({
  personaId: "persona-id",
  message: "Use the calculator to solve 2+2",
  role: "tool"
});
```

## Dependencies

All providers require:
- `AIPersonaProvider` - For persona management
- `ReactorMacroService` - For tool/macro execution
- `StreamingSessionManager` - For streaming session management
- `StreamingTransportManager` - For streaming transport

## Testing

Each provider can be tested independently:
```bash
# Test Google AI Service
npm test -- --grep "GoogleAIService"

# Test AWS Bedrock Service
npm test -- --grep "AWSBedrockService"

# Test Anthropic Service
npm test -- --grep "AnthropicService"
```

## Future Enhancements

- [ ] Add support for more AI providers (Cohere, Mistral, etc.)
- [ ] Implement unified streaming interface
- [ ] Add provider-specific model fine-tuning support
- [ ] Implement provider fallback mechanisms
- [ ] Add provider performance metrics and monitoring
