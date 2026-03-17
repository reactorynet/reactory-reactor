# OpenAIService Streaming Unit Test Plan

## Objective
Verify that the OpenAIService streaming implementation produces events with the
correct shapes expected by the client-side SSE consumer (`useSSE.ts`), and that
error handling behaves correctly.

## Key Findings from Analysis
1. **Completion event shape mismatch** -- `createCompletionEvent` wraps data as
   `AICompletionStreamingData { content, metadata: { finishReason, ... } }` but the
   client's `CompletionStreamingEvent.data` expects `{ content, finishReason, thinking? }`.
2. **`createErrorEvent` call-site parameter swap** -- callers at lines 364-368 and
   517-520 pass `(message, code, recoverable, sessionId)` but the method signature
   is `(code, message, details?, sessionId?)`.
3. **Tool call events are emitted post-stream** -- not during streaming. This is
   acceptable for OpenAI since tool call deltas arrive incrementally, but we should
   verify the final events have the correct shape.

## Test Cases

### 1. `createCompletionEvent` produces client-compatible data
- GIVEN accumulated text and metadata
- WHEN createCompletionEvent is called
- THEN event.data must have `{ content, finishReason, thinking? }` at the top level
- AND event.type must be `StreamingEventType.COMPLETE`

### 2. `createCompletionEvent` includes thinking when reasoning is present
- GIVEN accumulated reasoning text
- WHEN the completion event is augmented with thinking
- THEN event.data.thinking must equal the reasoning content

### 3. `createErrorEvent` produces correctly shaped error data
- GIVEN an error code and message
- WHEN createErrorEvent is called
- THEN event.data must have `{ code, message, details? }`
- AND event.type must be `StreamingEventType.ERROR`

### 4. `createTokenEvent` produces correct token data
- GIVEN content, delta, position
- WHEN createTokenEvent is called
- THEN event.data must have `{ content, delta, position, isComplete }`

### 5. `createToolCallEvent` produces correct tool call data
- GIVEN tool id, name, arguments
- WHEN createToolCallEvent is called
- THEN event.data must have `{ id, name, arguments, isComplete }`

### 6. `handleStreamingRequest` accumulates text tokens correctly
- GIVEN a mock OpenAI stream that emits content deltas
- WHEN handleStreamingRequest processes the stream
- THEN it should send token events via transport manager
- AND send a completion event with all accumulated text

### 7. `handleStreamingRequest` accumulates tool calls correctly
- GIVEN a mock stream with tool_call deltas
- WHEN handleStreamingRequest processes the stream
- THEN it should emit tool_call events with correct IDs and arguments
- AND the reconstructed ChatCompletion should contain the tool calls

### 8. `handleStreamingRequest` handles stream errors
- GIVEN a stream that throws mid-way
- WHEN handleStreamingRequest processes the stream
- THEN it should send an error event via transport
- AND throw AIProviderError

### 9. `handleStreamingRequest` suppresses tool_call events in AUTO mode
- GIVEN tool calls and toolApprovalMode = AUTO
- WHEN handleStreamingRequest finishes
- THEN tool_call events should NOT be sent
- AND completion event should NOT be sent (deferred for AUTO tool loop)

### 10. Error event call sites pass parameters in correct order
- GIVEN a connection error during stream creation
- WHEN the catch block fires
- THEN the error event should have the error message in `data.message` and code in `data.code`
