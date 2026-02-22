import { ModuleMacro } from '../moduleMacro.macro';
import { createMockState } from './support/mockState';

// Mock the modules import
jest.mock('@reactory/server-core/modules', () => ({
  __esModule: true,
  default: {
    enabled: [
      {
        nameSpace: 'core',
        name: 'auth',
        version: '1.0.0',
        dependencies: ['core.users@1.0.0'],
        services: [{ id: 'core.AuthService@1.0.0' }],
      },
      {
        nameSpace: 'core',
        name: 'users',
        version: '2.0.0',
        dependencies: [],
        services: [
          { id: 'core.UserService@2.0.0' },
          { id: 'core.UserSearchService@1.0.0' },
        ],
      },
    ],
  },
}));

describe('ModuleMacro', () => {
  describe('summary (details=false)', () => {
    it('should return a list of modules with basic info', async () => {
      const state = createMockState();
      const result: any = await ModuleMacro({ details: false }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('list');
      expect(result.count).toBe(2);
      expect(result.modules[0]).toEqual({
        id: 'core.auth@1.0.0',
        nameSpace: 'core',
        name: 'auth',
        version: '1.0.0',
      });
    });

    it('should not include dependencies or services in summary mode', async () => {
      const state = createMockState();
      const result: any = await ModuleMacro({}, state);

      expect(result.modules[0]).not.toHaveProperty('dependencies');
      expect(result.modules[0]).not.toHaveProperty('services');
    });
  });

  describe('detailed (details=true)', () => {
    it('should include dependencies and service ids', async () => {
      const state = createMockState();
      const result: any = await ModuleMacro({ details: true }, state);

      expect(result.success).toBe(true);
      expect(result.details).toBe(true);
      const authModule = result.modules[0];
      expect(authModule.dependencies).toEqual(['core.users@1.0.0']);
      expect(authModule.services).toEqual(['core.AuthService@1.0.0']);
    });
  });
});
