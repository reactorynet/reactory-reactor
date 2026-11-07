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
 *   maxToolIterations:  200                       (optional — cap the auto tool loop)
 *                                                 (platform default 200; see services/reactor/toolIterations.ts)
 *   model / provider:   "claude-opus-4-8"         (optional — model/provider override)
 *   role:               "tool"                    (optional — user | tool | assistant | system; default user, or tool when toolCallId is set)
 *   toolCallId:         "call_abc123"             (optional — reply to a pending tool call: `message` becomes that call's result, sent back to the LLM)
 *   toolName:           "search_database"         (optional — the name of the tool being answered; pairs with toolCallId)
 *   toolArgs:           { query: "…" }            (optional — the args the tool was invoked with; recorded alongside the result)
 *
 * Resuming (sessionId): the turn is appended to the existing conversation AND the
 * session's per-turn settings (toolApprovalMode, model/provider, maxToolIterations)
 * are re-applied — the auto tool loop keys off the STORED session mode, so without
 * re-applying it a resumed turn would silently run under the session's old mode.
 *
 * Tool results (toolCallId): when the previous assistant turn requested a client-side
 * tool call, supply `toolCallId` (+ `toolName`) with `message` set to the tool's
 * result. The step sends it as a role="tool" message so the LLM receives it as the
 * answer to that call and continues the turn. Requires `sessionId` (you are answering
 * a call the agent made in an existing conversation).
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
const VALID_ROLES = ['user', 'tool', 'assistant', 'system'];

/**
 * Bound for `config.maxAttempts`. The upper bound is small on purpose: each
 * attempt can run a 150-iteration tool loop, so a larger budget is a runaway,
 * and 10 is well above the four attempts the incident tolerated.
 */
const MAX_ATTEMPT_BOUND = 10;

/** Normalise `config.maxAttempts` to an integer in [1, MAX_ATTEMPT_BOUND]. */
function clampAttempts(value: any): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_ATTEMPT_BOUND, Math.max(1, Math.floor(numeric)));
}

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
  /**
   * Attempts for a turn that FAILS (a provider fault, an error response, a
   * rejected session start, or an exception thrown out of the attempt).
   *
   * This is deliberately implemented INSIDE the step. A workflow can mark the
   * step `continueOnError: true` so a failure does not end the run, but that
   * also bypasses the engine's Retry strategy: YamlStepBody converts a reported
   * failure into `ExecutionResult.next()`, so workflow-es never reaches the
   * error path where Retry is selected and a step-level `retryPolicy` never
   * fires. Without in-step retries the first transient provider hiccup ends the
   * run (REACTORY-302016408: four attempts were tolerated before the fault was
   * treated as fatal). Default 1 = no retry.
   */
  maxAttempts?: number;
  /** Delay between attempts in milliseconds. Default 0 (immediate). */
  attemptDelayMs?: number;
  /** Optional model / provider override for the session. */
  model?: string;
  provider?: string;
  /**
   * Message role — 'user' (default), 'tool', 'assistant' or 'system'. When
   * `toolCallId` is supplied and `role` is omitted, it defaults to 'tool'.
   */
  role?: string;
  /**
   * Reply to a pending tool call: the id of the tool call the agent made on a
   * previous turn. When set, `message` is sent as that call's result (role
   * 'tool') and forwarded to the LLM. Requires an existing `sessionId`.
   */
  toolCallId?: string;
  /** The name of the tool being answered — pairs with `toolCallId`. */
  toolName?: string;
  /** The arguments the tool was invoked with — recorded alongside the result. */
  toolArgs?: any;
  enabled?: boolean;
}

export class AgentConversationStep extends BaseYamlStep {
  public readonly stepType = 'agent_conversation';

  /**
   * Run the turn, retrying a REPORTED failure up to `config.maxAttempts` times.
   *
   * Nothing escapes this method. An exception thrown by an attempt (template
   * resolution, service lookup, a provider SDK blowing up) is converted into a
   * failed result instead of propagating: YamlStepBody rethrows before it
   * consults `continueOnError`, so an escaping throw would defeat the tolerance
   * the caller declared. That makes `continueOnError` sufficient on its own - a
   * failure here is always reported, never fatal.
   */
  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as AgentConversationStepConfig;
    const maxAttempts = clampAttempts(config.maxAttempts);
    const delayMs = Number.isFinite(Number(config.attemptDelayMs)) && Number(config.attemptDelayMs) > 0
      ? Number(config.attemptDelayMs)
      : 0;

    let result: StepExecutionResult | null = null;
    let attempts = 0;
    let resumeSessionId: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        result = await this.runAttempt(context, config, resumeSessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        context.logger.error(`Agent conversation attempt ${attempt} threw: ${message}`);
        result = {
          success: false,
          error: message,
          outputs: {},
          // A throw is never a configuration verdict, so it is retryable.
          metadata: { personaId: config.personaId, retryable: true },
        };
      }

      const failure = result as StepExecutionResult;
      if (failure.success) break;

      const metadata = (failure.metadata || {}) as Record<string, any>;
      const retryable = metadata.retryable !== false;
      const remaining = maxAttempts - attempt;
      if (!retryable || remaining <= 0) break;

      // Reuse the session the failed attempt managed to create: a retry must be a
      // continuation, not a second conversation, or every provider hiccup leaves a
      // stray session behind and re-pays the whole prompt.
      const created = (failure.outputs || {}) as Record<string, any>;
      if (typeof created.sessionId === 'string' && created.sessionId.trim() !== '') {
        resumeSessionId = created.sessionId;
      }

      context.logger.warn(
        `Agent conversation attempt ${attempt}/${maxAttempts} failed (${failure.error}); retrying` +
          (resumeSessionId ? ` in session "${resumeSessionId}"` : '') +
          '.',
      );
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const final = result as StepExecutionResult;
    // Attempts are recorded on BOTH metadata and outputs: metadata is for operators,
    // outputs are what a workflow step can read back (e.g. to report how many
    // attempts a reviewer needed before it produced a verdict).
    final.metadata = { ...(final.metadata || {}), attempts };
    final.outputs = { ...(final.outputs || {}), attempts };
    return final;
  }

  /** One attempt at the turn. Reports failure; the caller decides whether to retry. */
  private async runAttempt(
    context: StepExecutionContext,
    config: AgentConversationStepConfig,
    resumeSessionId?: string,
  ): Promise<StepExecutionResult> {
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
    // An earlier attempt of THIS step may have created a conversation before it
    // failed; resume it rather than starting a second one.
    if (!sessionId && resumeSessionId) {
      sessionId = resumeSessionId;
    }

    const model = config.model ? this.resolveTemplate(config.model, context) : undefined;
    const provider = config.provider ? this.resolveTemplate(config.provider, context) : undefined;

    // Tool-call reply: when `toolCallId` is present this turn is the RESULT of a
    // tool call the agent made previously, sent back to the LLM as a role="tool"
    // message. `role` defaults to 'tool' in that case, otherwise 'user'.
    // Like `sessionId`, an unsupplied optional input leaves its "${...}" token
    // intact — treat a leftover token (or empty string) as "not provided" so it
    // does not wrongly flip the turn into tool-result mode.
    const cleanOptional = (v: string | undefined): string | undefined => {
      const resolved = v ? this.resolveTemplate(v, context) : undefined;
      if (typeof resolved === 'string' && (resolved.trim() === '' || resolved.includes('${'))) {
        return undefined;
      }
      return resolved;
    };
    const toolCallId = cleanOptional(config.toolCallId);
    const toolName = cleanOptional(config.toolName);
    const toolArgs =
      typeof config.toolArgs === 'string' ? cleanOptional(config.toolArgs) : config.toolArgs;
    const role = cleanOptional(config.role) || (toolCallId ? 'tool' : 'user');

    const conversationService: any = this.getConversationService(context);
    if (!conversationService || typeof conversationService.sendMessage !== 'function') {
      return {
        success: false,
        error: `Conversation service (${CONVERSATION_SERVICE_ID}) is not available`,
        outputs: {},
        // A missing service is configuration, not a transient fault: retrying would
        // only re-resolve the same absent dependency.
        metadata: { personaId, retryable: false },
      };
    }
    if (promptKey && typeof conversationService.sendCannedPrompt !== 'function') {
      return {
        success: false,
        error: `Conversation service (${CONVERSATION_SERVICE_ID}) does not support canned prompts (sendCannedPrompt)`,
        outputs: {},
        // A missing capability is a wiring error, not a transient fault.
        metadata: { personaId, promptKey, retryable: false },
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
      } else {
        context.logger.info(`Resuming agent conversation "${sessionId}" with persona "${personaId}"`);
      }

      // Apply per-turn session settings for BOTH new and resumed conversations.
      // This matters most on resume: the server-side auto tool loop keys off the
      // STORED conversation.toolApprovalMode (sendMessage does not update it when
      // appending to history), so without re-applying it here a resumed turn would
      // run under whatever mode the session was last left in — e.g. tools that
      // should auto-execute would instead pause for approval.
      // Each rejection handler is EXPLICITLY annotated `(): void`. These are
      // best-effort session settings - a failure here must not fail the turn - and an
      // unannotated `() => undefined` is the shape that trips TS7011 ("implicitly has
      // return type any ... referenced in one of its return expressions") once the
      // service is typed. Naming the type keeps the file clean under any config.
      if (typeof conversationService.setChatToolApprovalMode === 'function') {
        await conversationService.setChatToolApprovalMode(sessionId, toolApprovalMode).catch((): void => undefined);
      }
      if (typeof config.maxToolIterations === 'number' && typeof conversationService.setChatMaxToolIterations === 'function') {
        await conversationService.setChatMaxToolIterations(sessionId, config.maxToolIterations).catch((): void => undefined);
      }
      if ((model || provider) && typeof conversationService.setChatModelProvider === 'function') {
        await conversationService.setChatModelProvider(sessionId, model, provider).catch((): void => undefined);
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
            role,
            // Tool-call reply fields — only meaningful when answering a pending
            // tool call (role 'tool'). Passed through to be persisted in history
            // and forwarded to the provider so the LLM links the result to the call.
            ...(toolCallId ? { tool_call_id: toolCallId } : {}),
            ...(toolName ? { tool_name: toolName } : {}),
            ...(toolArgs !== undefined ? { tool_args: toolArgs } : {}),
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

      // A turn whose tool loop hit its budget is TRUNCATED, not finished: the agent
      // stopped mid-task with work outstanding. Reporting success here would let
      // the workflow — and a reviewer reading its outputs — treat a partial
      // implementation as complete, which is exactly the silent-truncation failure
      // this step used to exhibit (ticket REACTORY-302016408/20261017/3478149265).
      // Fail loudly so the run is visibly incomplete.
      if (response?.toolIterationLimitReached === true) {
        const completed = typeof response.iterationsCompleted === 'number'
          ? response.iterationsCompleted
          : null;
        const budget = typeof response.maxToolIterations === 'number'
          ? response.maxToolIterations
          : null;
        const progress = completed !== null && budget !== null
          ? `${completed}/${budget}`
          : 'an unknown number of';
        const error =
          `Agent tool loop reached its iteration limit (${progress} iterations) — the turn was truncated ` +
          `and the work is incomplete. Raise maxToolIterations for this step or continue the session ` +
          `before treating the result as final.`;

        context.logger.error(`Agent conversation truncated: ${error}`);

        return {
          success: false,
          error,
          outputs: {
            sessionId,
            truncated: true,
            ...(completed !== null ? { iterationsCompleted: completed } : {}),
            ...(budget !== null ? { maxToolIterations: budget } : {}),
          },
          metadata: {
            personaId,
            sessionId,
            // A truncated turn is a BUDGET verdict, not a transient fault: retrying
            // the same budget would truncate again at the same point.
            retryable: false,
            toolIterationLimitReached: true,
            ...(completed !== null ? { iterationsCompleted: completed } : {}),
          },
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
        metadata: { personaId, sessionId, toolApprovalMode, role, ...(toolCallId ? { toolCallId } : {}) },
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
    if (config.maxAttempts !== undefined
      && (typeof config.maxAttempts !== 'number' || !Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > MAX_ATTEMPT_BOUND)) {
      errors.push(`maxAttempts must be an integer between 1 and ${MAX_ATTEMPT_BOUND}`);
    }
    if (config.attemptDelayMs !== undefined
      && (typeof config.attemptDelayMs !== 'number' || config.attemptDelayMs < 0)) {
      errors.push('attemptDelayMs must be a non-negative number');
    }
    if (config.role !== undefined && !VALID_ROLES.includes(config.role)) {
      errors.push(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    // Tool-call replies flow through sendMessage (the canned-prompt path has no
    // notion of a tool result), so toolCallId and promptKey are mutually exclusive.
    if (config.toolCallId !== undefined && typeof config.promptKey === 'string' && config.promptKey.length > 0) {
      errors.push('toolCallId cannot be combined with promptKey — a tool result must be sent as a message');
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
