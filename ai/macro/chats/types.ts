/**
 * Type definitions for chats macros
 * These types define the props structure for chats macro functions
 */

/**
 * Props for the ChatsMacro function
 */
export interface ChatsMacroProps {
  /** The action to perform on chat sessions */
  action: 'new' | 'size' | 'list' | 'cont' | 'del' | 'exp' | 'train' | 'personas' | 'speakto' | 'followup' | 'respond' | 'clear';
  /** Optional chat session ID or persona ID for operations that require it */
  id?: string;
  /** Optional message to send to the target persona (for speakto agent-to-agent delegation or followup) */
  message?: string;
  /** Optional files for training operations */
  files?: string[];
  /** Optional model for training operations */
  model?: string;
  /** Optional provider for training operations */
  provider?: string;
  /** Number of recent history items to return for the followup action (default: 2) */
  historyCount?: number;
  /** Optional provider configuration (e.g. structured output schemas) */
  providerConfig?: any;
  /**
   * Used with 'speakto' (and a message). When true, the delegation is dispatched
   * non-blocking: the tool returns immediately with status "dispatched" and a
   * delegationId, and the sub-agent runs in the background. Retrieve the result
   * later with action="respond" and id=<delegationId>. Default false (blocking).
   */
  async?: boolean;
  /**
   * Used with async speakto. When false, suppresses the background callback
   * message pushed into the parent session when the delegation completes.
   * Default true.
   */
  wakeParent?: boolean;
  /**
   * Used with 'respond'. Milliseconds to wait for a running delegation before
   * returning "running" status (clamped to 0–120000, default 30000).
   */
  waitMs?: number;
}
