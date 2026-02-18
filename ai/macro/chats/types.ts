/**
 * Type definitions for chats macros
 * These types define the props structure for chats macro functions
 */

/**
 * Props for the ChatsMacro function
 */
export interface ChatsMacroProps {
  /** The action to perform on chat sessions */
  action: 'new' | 'size' | 'list' | 'cont' | 'del' | 'exp' | 'train' | 'personas' | 'speakto' | 'clear';
  /** Optional chat session ID or persona ID for operations that require it */
  id?: string;
  /** Optional message to send to the target persona (for speakto agent-to-agent delegation) */
  message?: string;
  /** Optional files for training operations */
  files?: string[];
  /** Optional model for training operations */
  model?: string;
}
