import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { IReactorConversationsService, UpdateChatDataInput } from '@reactory/server-modules/reactory-reactor/types/service.types';
import logger from "@reactory/server-core/logging";

/**
 * Parameters accepted by the `updateChatData` tool. Mirrors the service input
 * with an optional explicit session override (normally the active session is
 * used, so the model never has to know the conversation id).
 */
export interface UpdateChatDataProps extends UpdateChatDataInput {
  /** Optional explicit conversation id. Defaults to the active chat session. */
  chatSessionId?: string;
}

/**
 * Resolve the target conversation id from the macro state. Depending on the
 * execution path the state is either the persisted conversation document
 * (`_id`) or an in-memory `ChatState` (`id`).
 */
const resolveChatSessionId = (
  props: UpdateChatDataProps,
  state: ChatState
): string | undefined => {
  const anyState = state as any;
  return (
    props?.chatSessionId ||
    anyState?._id?.toString?.() ||
    (typeof anyState?._id === 'string' ? anyState._id : undefined) ||
    anyState?.id
  );
};

/**
 * The status palette the agent should pick from when signalling conversation
 * state with an icon + colour. Kept in one place so the tool description and
 * any downstream prompt guidance stay consistent.
 */
export const CHAT_STATUS_PALETTE: { status: string; icon: string; color: string }[] = [
  { status: 'in progress', icon: 'pending', color: '#f9a825' },
  { status: 'complete', icon: 'check_circle', color: '#2e7d32' },
  { status: 'blocked / error', icon: 'error', color: '#c62828' },
  { status: 'investigation', icon: 'search', color: '#1565c0' },
  { status: 'planning', icon: 'lightbulb', color: '#6a1b9a' },
];

/**
 * Updates the descriptive metadata of the active conversation so it is
 * recognisable in the chat history: a short title, a summary, discovery tags
 * and a status icon with a colour code.
 *
 * Every field is optional — only the supplied fields are written. The agent
 * calls this early to name a session and again when its focus or status
 * changes.
 */
export const UpdateChatDataMacro: Macro<unknown, UpdateChatDataProps> = async (
  props: UpdateChatDataProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const ctx = context ?? (state as any)?.context;
  const chatSessionId = resolveChatSessionId(props, state);

  logger.info(
    `UpdateChatDataMacro: session=${chatSessionId}, fields=${JSON.stringify(Object.keys(props || {}))}`
  );

  try {
    if (!chatSessionId) {
      return {
        success: false,
        error: 'No active chat session to update.',
        instructions: [
          '## Chat Data Not Updated',
          '',
          'There is no active chat session id available. This normally means the',
          'conversation has not been persisted yet.',
          '',
          '### Suggested Next Steps:',
          '- Continue the conversation; the session is created on the first message',
          '- Retry `updateChatData` once the session exists',
        ].join('\n'),
      };
    }

    if (!ctx || typeof ctx.getService !== 'function') {
      return {
        success: false,
        error: 'No request context available to update chat data.',
        instructions: [
          '## Chat Data Not Updated',
          '',
          'The tool could not resolve a service context, so the conversation could',
          'not be updated.',
        ].join('\n'),
      };
    }

    const conversationService =
      ctx.getService<IReactorConversationsService>('reactor.ReactorConversationService@1.0.0');

    if (!conversationService || typeof conversationService.updateChatData !== 'function') {
      return {
        success: false,
        error: 'ReactorConversationService.updateChatData is not available.',
        instructions: [
          '## Chat Data Not Updated',
          '',
          'The conversation service does not expose `updateChatData`. The tool is',
          'registered but the server build does not support it yet.',
        ].join('\n'),
      };
    }

    // Build the update payload from only the fields actually supplied so a
    // title refresh never clears tags/summary and vice versa.
    const data: UpdateChatDataInput = {};
    if (typeof props?.title === 'string') data.title = props.title;
    if (typeof props?.summary === 'string') data.summary = props.summary;
    if (Array.isArray(props?.tags)) data.tags = props.tags;
    if (typeof props?.icon === 'string') data.icon = props.icon;
    if (typeof props?.color === 'string') data.color = props.color;

    if (Object.keys(data).length === 0) {
      return {
        success: false,
        error: 'No updatable fields supplied.',
        instructions: [
          '## Chat Data Not Updated',
          '',
          '`updateChatData` requires at least one of: title, summary, tags, icon, color.',
        ].join('\n'),
      };
    }

    const updated = await conversationService.updateChatData(chatSessionId, data);

    const updatedFields = Object.keys(data);
    const result = {
      chatSessionId,
      title: updated?.title ?? null,
      summary: updated?.summary ?? null,
      tags: updated?.tags ?? [],
      icon: updated?.icon ?? null,
      color: updated?.color ?? null,
    };

    return {
      success: true,
      data: result,
      instructions: [
        `## Chat Data Updated`,
        '',
        `Updated: **${updatedFields.join(', ')}**`,
        '',
        '| field | value |',
        '|-------|-------|',
        `| title | ${result.title ?? '—'} |`,
        `| summary | ${result.summary ?? '—'} |`,
        `| tags | ${result.tags.length ? result.tags.join(', ') : '—'} |`,
        `| icon | ${result.icon ?? '—'} |`,
        `| color | ${result.color ?? '—'} |`,
        '',
        'Do not tell the user about this housekeeping call unless they asked about',
        'the conversation title, summary, tags or status.',
      ].join('\n'),
    };
  } catch (err) {
    const message = err?.message ?? 'Unknown error';
    logger.warn(`UpdateChatDataMacro failed: ${message}`);

    return {
      success: false,
      error: `Error updating chat data: ${message}`,
      instructions: [
        '## Chat Data Update Failed',
        '',
        `${message}`,
        '',
        '### Recovery Options:',
        '- Continue the conversation; the title/summary can be refreshed later',
        '- Ensure the field values are non-empty strings (tags must be an array)',
      ].join('\n'),
    };
  }
};

export const UpdateChatDataMacroRegistry: MacroComponentDefinition<typeof UpdateChatDataMacro> = {
  nameSpace: "reactor-macros",
  name: "updateChatData",
  version: "1.0.0",
  component: UpdateChatDataMacro,
  roles: ["USER"],
  description: [
    `# updateChatData`,
    `Set or update the descriptive metadata of the current chat session so it is`,
    `easy to find and understand in the chat history.`,
    ``,
    `Every field is optional — only the fields you provide are written.`,
    ``,
    `## Fields`,
    `| field   | type     | Description |`,
    `|---------|----------|-------------|`,
    `| title   | string   | Short, specific title (≈3-8 words, max ~80 chars). Replaces the auto-generated title. |`,
    `| summary | string   | 1-2 sentence summary of what the conversation is about. |`,
    `| tags    | string[] | Lower-case kebab-case discovery tags (e.g. ["auth","reactor","bugfix"]). Replaces the existing tag list. |`,
    `| icon    | string   | Material icon name for the status (e.g. "pending", "check_circle", "error"). |`,
    `| color   | string   | Hex colour code tinting the icon (e.g. "#f9a825"). |`,
    ``,
    `## When to use`,
    `- Once the intent of the conversation is clear, set a \`title\` and \`summary\`.`,
    `- Update the \`title\`/\`summary\` if the focus of the conversation changes.`,
    `- Set \`tags\` to make the session discoverable.`,
    `- Set \`icon\`+\`color\` to signal status as work progresses.`,
    ``,
    `## Status palette`,
    `| status | icon | color |`,
    `|--------|------|-------|`,
    `| in progress | pending | #f9a825 |`,
    `| complete | check_circle | #2e7d32 |`,
    `| blocked / error | error | #c62828 |`,
    `| investigation | search | #1565c0 |`,
    `| planning | lightbulb | #6a1b9a |`,
    ``,
    `## Notes`,
    `- Housekeeping tool: call it silently, do not narrate it to the user.`,
    `- Supplying \`tags\` replaces the whole list, so include any tags you want to keep.`,
  ].join('\n'),
  features: [
    {
      feature: "updateChatData",
      featureType: Reactory.FeatureType.function,
      action: ["update"],
      description: "Set the title, summary, tags and status icon/colour for the current chat session",
      stem: "updateChatData",
    },
  ],
  stem: "updateChatData",
  tags: ["chats", "conversation", "title", "summary", "tags", "icon", "color", "metadata", "update"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "updateChatData",
        description: [
          "Set or update the descriptive metadata of the current chat session so it is recognisable in the chat history.",
          "All fields are optional; only the fields you supply are written.",
          "Use `title` for a short, specific title (3-8 words), `summary` for a 1-2 sentence description, `tags` for lower-case kebab-case discovery tags, and `icon`+`color` to signal status (e.g. icon=\"check_circle\", color=\"#2e7d32\" for complete; icon=\"pending\", color=\"#f9a825\" for in progress; icon=\"error\", color=\"#c62828\" for blocked).",
          "Call this once the intent of the conversation is clear, and again when the focus or status changes.",
          "This is a silent housekeeping tool: do not mention it to the user unless they ask about the conversation metadata.",
        ].join(' '),
        icon: "edit_note",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short, specific title for the conversation (≈3-8 words, max ~80 characters). Replaces any auto-generated title.",
            },
            summary: {
              type: "string",
              description: "A 1-2 sentence summary of what the conversation is about. Used as the subtitle in the chat history.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Lower-case kebab-case discovery tags (e.g. [\"auth\", \"reactor\", \"bugfix\"]). Replaces the existing tag list, so include tags you want to keep.",
            },
            icon: {
              type: "string",
              description: "Material icon name describing the conversation status (e.g. \"pending\", \"check_circle\", \"error\", \"search\", \"lightbulb\").",
            },
            color: {
              type: "string",
              description: "Hex colour code used to tint the status icon (e.g. \"#f9a825\" for in progress, \"#2e7d32\" for complete, \"#c62828\" for blocked).",
            },
          },
          required: [],
        },
      },
    },
  ],
  alias: "updateChatData",
};

export default UpdateChatDataMacroRegistry;
