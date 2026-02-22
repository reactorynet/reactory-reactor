import { StateMacro } from '../stateMacro.macro';
import { createMockState } from './support/mockState';

describe('StateMacro', () => {
  it('should return a safe subset of the chat state', async () => {
    const state = createMockState({
      vars: { a: 1, b: 2 },
    });
    const result: any = await StateMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.operation).toBe('get');
    expect(result.sessionId).toBe('test-session-001');
    expect(result.variablesCount).toBe(2);
  });

  it('should include persona and model info', async () => {
    const state = createMockState();
    const result: any = await StateMacro({}, state);

    expect(result.chatState.botId).toBe('test-persona');
    expect(result.chatState.modelId).toBe('gpt-4');
  });

  it('should include user id', async () => {
    const state = createMockState();
    const result: any = await StateMacro({}, state);

    expect(result.chatState.user.id).toBe('user-123');
  });

  it('should handle zero variables gracefully', async () => {
    const state = createMockState({ vars: {} });
    const result: any = await StateMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.variablesCount).toBe(0);
  });
});
