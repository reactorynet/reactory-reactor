# Specification: AI Agent File Awareness for Reactor Chat

## Problem Statement

When users attach files to a Reactor chat session, the AI agent has **no awareness** of those files. Files are stored as ObjectId references on the conversation document (`conversation.files`) and file metadata is available via GraphQL queries, but none of this information reaches the AI provider when messages are sent. The agent cannot see what files are attached, cannot read their contents, and tool call/result history messages are silently dropped from the prompt.

## Current Architecture

### Data Flow (Simplified)

```
User attaches file
  -> ReactorAttachFile mutation (ReactorChat.ts:479-552)
  -> fileService.uploadFile() stores the file
  -> conversationService.attachFiles() (ReactorConversationService.ts:2802-2900)
     -> $push file ObjectId to conversation.files
     -> $push user message: "I have uploaded N file(s): name1, name2 to my user profile home folder."

User sends chat message
  -> ReactorSendMessage mutation (ReactorChat.ts:426-477)
  -> conversationService.sendMessage() (ReactorConversationService.ts:1973-2201)
     -> executeProviderChat() (ReactorConversationService.ts:1869-1907)
        -> OpenAIService.initialize() + chat()
        -> OR GoogleAIService.initialize() + chat()
```

### Where Things Break

#### 1. OpenAIService.createPrompt() (OpenAIService.ts:460-499)

```typescript
history.forEach((msg) => {
  if (msg?.content && typeof msg.content === "string") {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }
});
```

**Problems:**
- Only forwards messages that have a string `content`. Drops `role: "tool"` messages entirely.
- Drops messages with `tool_calls` arrays (assistant messages requesting tool execution).
- Does not inject any file context from `conversation.files`.
- After a tool is executed and its result stored in history, the result is lost on the next turn.

#### 2. GoogleAIService.getAIResponse() (GoogleAIService.ts:1152-1270)

Uses `this.chatState.history` to create a chat session via `createChatSession()`. Same structural problem: the history is loaded but file metadata from `conversation.files` is never injected as context.

#### 3. attachFiles() message (ReactorConversationService.ts:2828-2836)

```typescript
const fileMessage = {
  role: "user",
  content: `I have uploaded ${files.length} file(s): ${files
    .map((f) => f.filename || f.alias || "Unknown file")
    .join(", ")} to my user profile home folder.`,
};
```

**Problem:** Includes filenames but NOT the file paths. The AI cannot call the existing `readFile` tool without a path.

#### 4. attachUserFileToSession() (ReactorConversationService.ts:2904-3023)

Attaches an existing user file to the session but adds **no message to history at all**. The AI has zero awareness that a file was linked.

#### 5. loadChatState() does not populate files

When `OpenAIService.loadChatState()` (OpenAIService.ts:143-214) loads a conversation from MongoDB, it does NOT call `.populate("files")`. The `chatState` object used by `createPrompt()` has no file metadata available.

By contrast, `getChatSession()` in `ReactorConversationService.ts:1562-1588` DOES call `.populate("files")` -- but this is only used for GraphQL query responses, not for AI prompt building.

### Existing Tool Infrastructure

A `readFile` tool/macro already exists at:
`ai/macro/fs/ReadFile/ReadFile.ts`

Tool definition:
```json
{
  "type": "function",
  "function": {
    "name": "readFile",
    "description": "Reads a file and returns its content with metadata",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "The file path to read" }
      },
      "required": ["path"]
    }
  }
}
```

This tool reads files from the filesystem. It is restricted to the user's home directory. It is already registered in the MacroRegistry and available to personas with DEVELOPER or ADMIN roles.

**The tool works** -- the problem is purely that the AI doesn't know which files are attached or their paths.

### New Tool Needed: readChatFile

The existing `readFile` macro reads from the local filesystem using OS paths. Chat-attached files are stored via `ReactoryFileService` and accessed via their `link` URL or `path` property. A new `readChatFile` tool is needed that:
- Accepts a `fileId` (from the file manifest injected into context)
- Looks up the file via `ReactoryFileService` or directly from the conversation's populated `files` array
- Returns the file content as text (for text-based files) or a base64 data URI (for images)
- Is available to ALL roles (not just DEVELOPER/ADMIN like `readFile`)

## Key Files

All paths relative to: `/Users/wweber/Source/reactory/reactory-express-server/src/modules/reactory-reactor/`

| File | Purpose |
|------|---------|
| `services/reactor/providers/OpenAIService.ts` | OpenAI/xAI provider - `createPrompt()` (L460), `loadChatState()` (L143), `initialize()` (L216) |
| `services/reactor/providers/GoogleAIService.ts` | Google/Gemini provider - `getAIResponse()` (L1152), `createChatSession()`, `chat()` (L1549) |
| `services/reactor/providers/AIProviderBase.ts` | Shared base class - `chatState` property, `persistChatState()` |
| `services/reactor/ReactorConversationService.ts` | `attachFiles()` (L2802), `attachUserFileToSession()` (L2904), `sendMessage()` (L1973), `getChatSession()` (L1562) |
| `graphql/resolvers/ReactorChat.ts` | GraphQL resolvers - `ReactorAttachFile` (L479), `ReactorSendMessage` (L426) |
| `models/ReactorChatState.ts` | MongoDB schema - `ReactorConversationSchema` (L150), `ReactorConversationHistorySchema` (L128) |
| `ai/macro/fs/ReadFile/ReadFile.ts` | Existing `readFile` tool (L9-203) |
| `ai/openai/types/chat.ts` | `ChatState` type, `MacroToolDefinition`, etc. |

## Changes Required

### Change 1: Add `files` to `ChatState` type

**File:** `ai/openai/types/chat.ts`

Add a `files` field to the `ChatState` type so populated file documents are available to provider services:

```typescript
export type ChatState = {
  // ... existing fields ...
  files?: Array<{
    id: string;
    filename: string;
    mimetype: string;
    size: number;
    path: string;
    link?: string;
    alias?: string;
    created?: Date;
  }>;
};
```

### Change 2: Populate files in loadChatState (both providers)

**File:** `services/reactor/providers/OpenAIService.ts` (L143-214)

In `loadChatState()`, chain `.populate("files")` when loading the conversation from MongoDB, and store the populated file documents on `this.chatState.files`.

**File:** `services/reactor/providers/AIProviderBase.ts`

Alternatively, add a shared `loadChatState()` method in the base class that both providers call, which always populates files. `OpenAIService` currently has its own `loadChatState`; `GoogleAIService` inherits from `AIProviderBase` but may have its own loading logic. Verify both paths.

### Change 3: Inject file context system message in prompt building

**File:** `services/reactor/providers/OpenAIService.ts` -- `createPrompt()` (L460-499)

After building messages from history and before appending the user's new message, inject a system message listing all attached files if `this.chatState.files` has entries:

```typescript
if (this.chatState.files && this.chatState.files.length > 0) {
  const fileManifest = this.chatState.files.map(f => 
    `- id: "${f.id}", filename: "${f.filename}", path: "${f.path}", type: "${f.mimetype}", size: ${f.size}`
  ).join('\n');
  
  messages.push({
    role: "system",
    content: `The user has the following files attached to this chat session. You can read their contents using the readChatFile tool with the file id.\n\nAttached files:\n${fileManifest}`
  });
}
```

**File:** `services/reactor/providers/GoogleAIService.ts`

Apply the equivalent in `createChatSession()` or `getAIResponse()` where history/messages are built for the Gemini API. Google's API uses `systemInstruction` or a system-role content part -- adapt accordingly.

### Change 4: Forward tool_calls and tool-role messages in OpenAI prompt

**File:** `services/reactor/providers/OpenAIService.ts` -- `createPrompt()` (L469-477)

The current loop skips any message that doesn't have a string `content`. This drops:
- Assistant messages with `tool_calls` (the AI's request to execute a tool)
- Tool-role messages (the results of tool execution)

Replace the loop to properly forward all message types:

```typescript
history.forEach((msg) => {
  if (msg.role === "system" && msg.content) {
    messages.push({ role: "system", content: msg.content });
  } else if (msg.role === "user" && msg.content) {
    messages.push({ role: "user", content: msg.content });
  } else if (msg.role === "assistant") {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Assistant requesting tool calls
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) }
        }))
      });
    } else if (msg.content) {
      messages.push({ role: "assistant", content: msg.content });
    }
  } else if (msg.role === "tool" && msg.tool_call_id) {
    // Tool execution results
    messages.push({
      role: "tool",
      tool_call_id: msg.tool_call_id,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.tool_results || msg.content)
    });
  }
});
```

For GoogleAIService, Gemini uses a different format for function calls/responses. The `createChatSession` method already handles some of this via Gemini's native API, but verify that tool call history items are properly mapped to Gemini's `FunctionCall` / `FunctionResponse` content parts.

### Change 5: Improve attachFiles() message with file paths

**File:** `services/reactor/ReactorConversationService.ts` -- `attachFiles()` (L2828-2836)

Change the user message to include structured file information:

```typescript
const fileDetails = files.map(f => 
  `- "${f.filename || f.alias || 'Unknown'}" (${f.mimetype || 'unknown type'}, ${f.size ? Math.round(f.size/1024) + 'KB' : 'unknown size'}, path: ${f.path || 'N/A'}, id: ${f._id || f.id})`
).join('\n');

const fileMessage = {
  id: new ObjectId(),
  role: "user",
  content: `I have attached ${files.length} file(s) to this chat session:\n${fileDetails}\n\nYou can read the contents of any attached file using the readChatFile tool with the file id.`,
  timestamp: new Date(),
};
```

### Change 6: Add history message in attachUserFileToSession()

**File:** `services/reactor/ReactorConversationService.ts` -- `attachUserFileToSession()` (L2904-3023)

Currently this method silently attaches files. Add a history message (same format as Change 5) so the AI learns about files attached from the user's file explorer:

```typescript
const fileMessage = {
  id: new ObjectId(),
  role: "user",
  content: `I have attached a file from my files to this chat session:\n- "${file.filename}" (${file.mimetype}, path: ${file.path}, id: ${file._id || file.id})\n\nYou can read the contents using the readChatFile tool.`,
  timestamp: new Date(),
};

// Add to the $push operation:
$push: { files: fileObjectId, history: fileMessage },
```

### Change 7: Create readChatFile tool/macro

**New file:** `ai/macro/fs/ReadChatFile/ReadChatFile.ts`

This tool reads files that are attached to the current chat session by file ID:

```typescript
// Tool definition:
{
  type: "function",
  function: {
    name: "readChatFile",
    description: "Reads the contents of a file attached to the current chat session. Use the file id from the attached files list.",
    parameters: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The ID of the attached file to read"
        }
      },
      required: ["fileId"]
    }
  }
}
```

**Implementation approach:**
1. Look up the file by ID using `ReactoryFileService` or by querying `ReactoryFile` model
2. Validate the file belongs to the current conversation's `files` array (security)
3. For text-based files (text/*, application/json, application/xml, etc.): read and return content as string
4. For other files: return metadata only (filename, type, size) with a note that binary content cannot be displayed
5. Respect a size limit (e.g. 500KB for text content to avoid blowing up the context window)
6. Available to ALL roles (not restricted to DEVELOPER/ADMIN)

**Registration:** Add to the macro registry in `ai/macro/index.ts` alongside existing macros.

### Change 8: Register readChatFile in macro index

**File:** `ai/macro/index.ts` (or wherever macros are registered)

Import and register `ReadChatFileComponentRegister` so it appears in `getToolsDefinitions()`.

## Testing Plan

1. Attach a text file to a chat session; send "what files do I have attached?" -- the AI should list them with metadata
2. Attach a file and ask "read the contents of [filename]" -- the AI should call `readChatFile` and display the contents
3. Attach a file via the file explorer sidebar (attachUserFileToSession) -- verify the history message appears
4. Verify existing `readFile` tool still works for filesystem paths
5. Test with both OpenAI and Google AI providers
6. Verify tool call history is preserved across turns (ask a follow-up about a previously-read file)
7. Test with large files to verify the size limit is respected

## Migration / Backward Compatibility

- No database schema changes required (files array and history schema already support the needed fields)
- Existing conversations will gain file awareness on their next message (the file context system message is injected dynamically at prompt build time)
- The readChatFile tool is additive; no existing tools are modified
- The improved history message format in attachFiles() is backward-compatible (still a string content)
