/**
 * Type definitions for chats macros
 * These types define the props structure for chats macro functions
 */

/**
 * Props for the ChatsMacro function
 */
export interface ChatsMacroProps {
  /** The action to perform on chat sessions */
  action: 'new' | 'size' | 'list' | 'cont' | 'del' | 'exp' | 'train' | 'personas' | 'speakto' | 'followup' | 'clear';
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
}
