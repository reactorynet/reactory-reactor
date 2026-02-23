import { EnvironmentMacro } from '../environmentMacro.macro';
import { createMockState } from './support/mockState';

describe('EnvironmentMacro', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Provide a predictable set of env vars for testing
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      PORT: '4000',
      SECRET_KEY: 'super-secret',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('list (no envKey)', () => {
    it('should return only allowed safe variables', async () => {
      const state = createMockState();
      const result: any = await EnvironmentMacro({}, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('list');
      // NODE_ENV and PORT are in the allowed list
      expect(result.environmentVariables).toHaveProperty('NODE_ENV', 'test');
      expect(result.environmentVariables).toHaveProperty('PORT', '4000');
      // SECRET_KEY should not appear (it is not in the allowed list)
      expect(result.environmentVariables).not.toHaveProperty('SECRET_KEY');
    });
  });

  describe('get (with envKey)', () => {
    it('should return a specific environment variable', async () => {
      const state = createMockState();
      const result: any = await EnvironmentMacro({ envKey: 'NODE_ENV' }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('get');
      expect(result.value).toBe('test');
    });

    it('should return any env var by key, even outside the safe list', async () => {
      const state = createMockState();
      const result: any = await EnvironmentMacro({ envKey: 'SECRET_KEY' }, state);

      expect(result.success).toBe(true);
      expect(result.value).toBe('super-secret');
    });

    it('should fail for a non-existent variable', async () => {
      const state = createMockState();
      const result: any = await EnvironmentMacro({ envKey: 'DOES_NOT_EXIST' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
