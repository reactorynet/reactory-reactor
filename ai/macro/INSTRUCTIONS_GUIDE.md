# Macro Instructions Field Guide

Every macro **must** include a structured `instructions` field in its response to enable AI agents (with or without reasoning capabilities) to accurately determine what happened and what to do next.

## Required Response Shape

```typescript
{
  success: boolean;
  error?: string;              // Human-readable error message (on failure)
  errorCode?: MacroErrorCode;  // Machine-readable error code (on failure)
  data?: T;                    // Operation-specific result data
  instructions: string;        // Markdown-formatted agent guidance (REQUIRED)
  metadata?: {
    executionTime: number;
    timestamp: Date;
    user?: string;
  };
}
```

## Instructions Field Template

Use Markdown with these standard sections:

```markdown
## {Title — what happened}

{One-line summary with key data points from the result}

### {Context} Information:
- **Field**: value
- **Field**: value

### Available Data:
- **fieldName**: What this field contains and when to use it
- **fieldName**: What this field contains and when to use it

### State Variables Available:
- lastXxx: Description of what was stored for future reference

### Suggested Next Steps:
- Use `toolName` with `paramName` to {achieve next goal}
- If {condition}, consider `alternativeTool` instead
```

## Rules

1. **Every response path** (success AND error) must include `instructions`
2. **Use template literals** with runtime data — never return static strings
3. **Include at least**: summary, available data fields, one suggested next step
4. **Conditional branching**: Use ternary operators for different states (found/not-found, empty/populated, success/partial-failure)
5. **Reference other tools by name** in "Suggested Next Steps" so agents know which tool to call
6. **Plain-string responses are forbidden** — always return a structured object

## Error Response Template

```markdown
## {Tool Name} — Error

{What went wrong in plain language}

### Error Details:
- **Error Code**: {errorCode}
- **Message**: {error message}
- **Parameters Received**: {echo back params}

### Recovery Options:
- {Specific recovery action with tool name}
- {Alternative approach}
```

## Examples

### Good — Conditional with next-step guidance (GetUser pattern)
```typescript
instructions: found
  ? `## User Found\nSuccessfully found **${name}**.\n\n### Available Data:\n- **id**: Use for referencing this user\n- **email**: ${email}\n\n### Suggested Next Steps:\n- Use \`queryGQL\` to fetch user's projects`
  : `## User Not Found\nNo user with email **${email}**.\n\n### Suggested Next Steps:\n- Use \`createUser\` to create this user\n- Verify the email spelling`
```

### Good — Concise action-oriented (SocialEyes pattern)
```typescript
instructions: `## Inbox — ${count} messages (page ${page})\nUnread: ${unread}. ${hasNext ? 'More pages available.' : 'End of inbox.'}\n\nTo read a thread: \`getConversation\` with conversationId.\nTo reply: \`replyToMessage\` with messageId.`
```

### Bad — Plain string with no structure
```typescript
// DON'T DO THIS
return "New chat session created";

// DO THIS INSTEAD
return {
  success: true,
  data: { sessionId },
  instructions: `## Chat Session Created\nSession **${sessionId}** is ready.\n\n### Suggested Next Steps:\n- Use \`chats\` with action \`cont\` and this sessionId to continue the conversation`
};
```

## Checklist for New Macros

- [ ] `instructions` field present in success response
- [ ] `instructions` field present in error response
- [ ] Runtime data interpolated (not static text)
- [ ] At least one "Suggested Next Step" with a tool name
- [ ] Empty/not-found states handled with different guidance
- [ ] Available data fields documented in instructions
