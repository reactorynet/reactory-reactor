/**
 * AgentConversationStep — run a conversation with a Reactory AI agent (persona)
 * as a durable, retryable workflow step.
 *
 * This is the workflow-step analogue of the `chats` macro / tool: it creates a
 * conversation with specific instructions and auto tool approval, then sends a
 * message and returns the agent's response. Because YAML workflows run on the
 * durable workflow-es engine, an agent turn becomes a first-class, persistable,
 * retryable step in a larger flow.
 *
 * It delegates entirely to `reactor.ReactorConversationService@1.0.0` —
 * `startChatSession` (systemPrompt = instructions, toolApprovalMode = auto) then
 * `sendMessage` — so tool execution, persona resolution and persistence are
 * handled by the existing conversation engine.
 *
 * Config (from YAML `inputs` JSON):
 *   personaId:          "reactor"                 (required — the AI agent/persona id)
 *   message:            "Summarise ${steps.x.outputs.text}"  (required unless promptKey is set — the prompt)
 *   promptKey:          "commitReviewPrompt"      (optional — use a named canned prompt from the persona instead of message)
 *   promptVariables:    { branch: "${steps.b.outputs.stdout}" }  (optional — values for the canned prompt's ${...} placeholders)
 *   providerConfig:     { structuredOutput: { schema: {...} }, reasoningEffort: "high" }  (optional — augmented per-turn config)
 *   instructions:       "You are a careful analyst…"          (optional — system prompt for the session)
 *   toolApprovalMode:   "auto"                    (optional — auto | safe_auto | prompt | plan; default auto)
 *   promptMergeStrategy:"append"                  (optional — append | prepend | replace; default append)
 *   sessionId:          "${convId}"               (optional — resume an existing conversation for idempotent retries; ${convId} is a bare workflow-variable reference)
 *   maxToolIterations:  25                        (optional — cap the auto tool loop)
 *   model / provider:   "claude-opus-4-8"         (optional — model/provider override)
 *
 * Output: { sessionId, content, response }
 *   - sessionId: persist this (e.g. via set_variable) and feed back as `sessionId`
 *     so an engine retry resumes the same conversation instead of starting over.
 */

import { BaseYamlStep } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/base/BaseYamlStep';
import {
  StepExecutionContext,
  StepExecutionResult,
  ValidationResult,
} from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { StreamingMode } from '@reactory/server-modules/reactory-reactor/services/reactor/types/streaming.types';
import { ReactorProviderConfig } from '@reactory/server-modules/reactory-reactor/types/model.types';

const CONVERSATION_SERVICE_ID = 'reactor.ReactorConversationService@1.0.0';

const VALID_TOOL_MODES = ['auto', 'safe_auto', 'prompt', 'plan'];
const VALID_MERGE_STRATEGIES = ['append', 'prepend', 'replace'];

/**
 * The conversation service returns a `{ __typename: 'ReactorErrorResponse', ... }`
 * object on failure (it does not throw). Extract a readable message + nested
 * detail so the workflow surfaces the real cause (e.g. an unknown personaId).
 */
function describeErrorResponse(resp: any): string {
  const base = resp?.message || 'error response';
  const details = resp?.details;
  const detailMsg =
    details instanceof Error
      ? details.message
      : details?.message || (typeof details === 'string' ? details : undefined);
  return detailMsg ? `${base} — ${detailMsg}` : base;
}

export interface AgentConversationStepConfig {
  /** The AI agent/persona id to converse with. */
  personaId: string;
  /** The message/prompt to send to the agent. Required unless `promptKey` is set. */
  message?: string;
  /**
   * Use a named "canned prompt" from the persona's `prompts` map as the message
   * body instead of an inline `message`. Rendered with `promptVariables`.
   */
  promptKey?: string;
  /** Values for the canned prompt template's `${...}` placeholders (templatable). */
  promptVariables?: Record<string, any>;
  /**
   * Provider-agnostic augmented config for the turn: structured output, reasoning
   * effort, sampling, response modalities. Passed straight through to the
   * conversation service.
   */
  providerConfig?: ReactorProviderConfig;
  /** System-prompt instructions for the conversation. */
  instructions?: string;
  /** Tool approval mode — default 'auto' (execute all tools without prompting). */
  toolApprovalMode?: string;
  /** How the instructions merge with the persona's base prompt. */
  promptMergeStrategy?: 'append' | 'prepend' | 'replace';
  /** Resume an existing conversation instead of creating a new one. */
  sessionId?: string;
  /** Cap on the auto tool-call loop before pausing. */
  maxToolIterations?: number;
  /** Optional model / provider override for the session. */
  model?: string;
  provider?: string;
  enabled?: boolean;
}

export class AgentConversationStep extends BaseYamlStep {
  public readonly stepType = 'agent_conversation';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as AgentConversationStepConfig;

    if (!context.reactoryContext) {
      return {
        success: false,
        error: 'No Reactory context available — cannot run an agent conversation',
        outputs: {},
        metadata: {},
      };
    }

    const personaId = this.resolveTemplate(config.personaId, context);
    const message = config.message ? this.resolveTemplate(config.message, context) : '';
    const promptKey = config.promptKey ? this.resolveTemplate(config.promptKey, context) : undefined;
    // Resolve each canned-prompt variable value (values may reference step outputs).
    const promptVariables: Record<string, any> = {};
    if (config.promptVariables && typeof config.promptVariables === 'object') {
      for (const [k, v] of Object.entries(config.promptVariables)) {
        promptVariables[k] = typeof v === 'string' ? this.resolveTemplate(v, context) : v;
      }
    }
    const providerConfig = config.providerConfig;
    const instructions = config.instructions ? this.resolveTemplate(config.instructions, context) : '';
      const toolApprovalMode = (config.toolApprovalMode as ToolApprovalMode) || ToolApprovalMode.AUTO;
    const promptMergeStrategy = config.promptMergeStrategy || 'append';
    let sessionId = config.sessionId ? this.resolveTemplate(config.sessionId, context) : undefined;
    // `sessionId` is optional. When the caller does not supply it, the YAML
    // reference (e.g. "${input.sessionId}") is left intact by resolveTemplate
    // by design — unresolved optional tokens are passed through, not blanked.
    // A leftover "${...}" token (or an empty string) means "no session", so
    // start a fresh conversation instead of trying to resume an invalid id.
    if (typeof sessionId === 'string' && (sessionId.trim() === '' || sessionId.includes('${'))) {
      sessionId = undefined;
    }

    const conversationService: any = this.getConversationService(context);
    if (!conversationService || typeof conversationService.sendMessage !== 'function') {
      return {
        success: false,
        error: `Conversation service (${CONVERSATION_SERVICE_ID}) is not available`,
        outputs: {},
        metadata: { personaId },
      };
    }
    if (promptKey && typeof conversationService.sendCannedPrompt !== 'function') {
      return {
        success: false,
        error: `Conversation service (${CONVERSATION_SERVICE_ID}) does not support canned prompts (sendCannedPrompt)`,
        outputs: {},
        metadata: { personaId, promptKey },
      };
    }

    try {
      // Create a new conversation (with instructions + auto tool approval) unless
      // we are resuming an existing one.
      if (!sessionId) {
        context.logger.info(
          `Starting agent conversation with persona "${personaId}" (toolApprovalMode=${toolApprovalMode})`,
        );
        const session: any = await conversationService.startChatSession({
          personaId,
          systemPrompt: instructions,
          streamingMode: StreamingMode.NONE,
          toolApprovalMode,
          promptMergeStrategy,
          // Both must be arrays — startChatSession iterates them (args.macros.forEach).
          tools: [],
          macros: [],
        });

        // startChatSession catches internal errors and RETURNS a
        // ReactorErrorResponse (it does not throw) — surface the real cause
        // (e.g. an unknown personaId) instead of a generic "no session id".
        if (session?.__typename === 'ReactorErrorResponse') {
          const detail = describeErrorResponse(session);
          context.logger.error(`Failed to start agent conversation: ${detail}`);
          return {
            success: false,
            error: `Failed to start agent conversation with persona "${personaId}": ${detail}`,
            outputs: {},
            metadata: { personaId },
          };
        }

        sessionId = session?.id || session?._id?.toString?.() || session?.sessionId;
        if (!sessionId) {
          return {
            success: false,
            error: 'Failed to create a conversation session (no session id returned)',
            outputs: {},
            metadata: { personaId },
          };
        }

        if (typeof config.maxToolIterations === 'number' && typeof conversationService.setChatMaxToolIterations === 'function') {
          await conversationService.setChatMaxToolIterations(sessionId, config.maxToolIterations).catch(() => undefined);
        }
        if ((config.model || config.provider) && typeof conversationService.setChatModelProvider === 'function') {
          await conversationService.setChatModelProvider(sessionId, config.model, config.provider).catch(() => undefined);
        }
      } else {
        context.logger.info(`Resuming agent conversation "${sessionId}" with persona "${personaId}"`);
      }

      // When a canned prompt key is supplied, render it from the persona's prompt
      // library via sendCannedPrompt; otherwise send the inline message. Both honour
      // the optional providerConfig (structured output, reasoning effort, sampling).
      const response: any = promptKey
        ? await conversationService.sendCannedPrompt({
            personaId,
            promptKey,
            variables: promptVariables,
            chatSessionId: sessionId,
            streamingMode: StreamingMode.NONE,
            toolApprovalMode,
            providerConfig,
          })
        : await conversationService.sendMessage({
            message,
            personaId,
            chatSessionId: sessionId,
            streamingMode: StreamingMode.NONE,
            toolApprovalMode,
            providerConfig,
          });

      if (response?.__typename === 'ReactorErrorResponse') {
        const detail = describeErrorResponse(response);
        context.logger.error(`Agent conversation turn failed: ${detail}`);
        return {
          success: false,
          error: `Agent conversation turn failed: ${detail}`,
          outputs: { sessionId },
          metadata: { personaId, sessionId },
        };
      }

      const content =
        response?.content ||
        response?.message ||
        (typeof response === 'string' ? response : undefined) ||
        '';

      // When a structured-output request was made and the provider returned valid
      // JSON, the conversation service exposes the parsed object as
      // `structuredContent`. Surface it so downstream steps can use it directly
      // (the raw JSON string is still available on `content`).
      const structuredContent = response?.structuredContent;

      context.logger.info(`Agent "${personaId}" responded (session: ${sessionId})`);

      // IMPORTANT: only return serializable essentials. Workflow step outputs are
      // persisted into the durable workflow instance data — putting the raw
      // conversation `response` object (provider/mongoose document, possibly
      // circular / non-BSON-serializable) there breaks instance persistence, which
      // silently discards the step advance and causes the engine to re-run this
      // step forever. `content` (the agent's text) + `sessionId` are all callers need.
      return {
        success: true,
        outputs: {
          sessionId,
          content,
          ...(structuredContent !== undefined ? { structuredContent } : {}),
        },
        metadata: { personaId, sessionId, toolApprovalMode },
      };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      context.logger.error(`Agent conversation failed: ${messageText}`);
      return {
        success: false,
        error: messageText,
        outputs: sessionId ? { sessionId } : {},
        metadata: { personaId, sessionId },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];

    if (!config.personaId || typeof config.personaId !== 'string') {
      errors.push('personaId is required and must be a string');
    }
    // Either an inline message or a canned prompt key must be supplied.
    const hasMessage = typeof config.message === 'string' && config.message.length > 0;
    const hasPromptKey = typeof config.promptKey === 'string' && config.promptKey.length > 0;
    if (!hasMessage && !hasPromptKey) {
      errors.push('either message or promptKey is required (message must be a string; promptKey a persona prompt name)');
    }
    if (config.promptVariables !== undefined && (typeof config.promptVariables !== 'object' || Array.isArray(config.promptVariables))) {
      errors.push('promptVariables must be an object map of variable names to values');
    }
    if (config.toolApprovalMode !== undefined && !VALID_TOOL_MODES.includes(config.toolApprovalMode)) {
      errors.push(`toolApprovalMode must be one of: ${VALID_TOOL_MODES.join(', ')}`);
    }
    if (
      config.promptMergeStrategy !== undefined &&
      !VALID_MERGE_STRATEGIES.includes(config.promptMergeStrategy)
    ) {
      errors.push(`promptMergeStrategy must be one of: ${VALID_MERGE_STRATEGIES.join(', ')}`);
    }
    if (
      config.maxToolIterations !== undefined &&
      (typeof config.maxToolIterations !== 'number' || config.maxToolIterations < 1)
    ) {
      errors.push('maxToolIterations must be a positive number');
    }

    return { valid: errors.length === 0, errors };
  }

  private getConversationService(context: StepExecutionContext): any {
    try {
      return context.reactoryContext?.getService(CONVERSATION_SERVICE_ID) ?? null;
    } catch {
      return null;
    }
  }
}
