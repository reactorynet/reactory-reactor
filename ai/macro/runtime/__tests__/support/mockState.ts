import { ChatState } from '../../../../types/chat';

/**
 * Creates a minimal ChatState for testing macros.
 * Only the fields that runtime macros actually use are populated.
 */
export function createMockState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    id: 'test-session-001',
    host: 'server',
    personaId: 'test-persona',
    persona: {
      id: 'test-persona',
      name: 'Test Bot',
      description: 'A test persona',
    } as any,
    started: new Date('2025-01-01T00:00:00Z'),
    apiKey: 'test-key',
    apiOrg: 'test-org',
    modelId: 'gpt-4',
    history: [] as any,
    ai: {} as any,
    user: { id: 'user-123' },
    macros: [],
    tools: [],
    vars: {},
    ...overrides,
  } as ChatState;
}
