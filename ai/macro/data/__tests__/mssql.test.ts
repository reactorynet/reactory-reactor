const mockMssqlQuery = jest.fn();
const mockMssqlClose = jest.fn();

jest.mock('mssql', () => {
  const pool = {
    request: jest.fn(() => ({ query: mockMssqlQuery })),
    close: mockMssqlClose,
  };

  return {
    ConnectionPool: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(pool),
    })),
  };
});

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { MsSqlMacro, MsSqlMacroRegistry } from '../mssql/macro';
import { createMockState, mssqlConnection } from './support/mockState';

const MSSQL_RESULT = {
  recordset: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
};

describe('MsSqlMacro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMssqlClose.mockResolvedValue(undefined);
    mockMssqlQuery.mockResolvedValue(MSSQL_RESULT);
  });

  const validProps = {
    connectionId: 'test-mssql',
    query: 'SELECT * FROM users',
    name: 'User List',
  };

  // ── Validation ──────────────────────────────────────────────

  describe('validation', () => {
    it('should fail when connectionId is missing', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro({ ...validProps, connectionId: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection ID');
    });

    it('should fail when query is missing', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro({ ...validProps, query: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Query');
    });

    it('should fail when name is missing', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro({ ...validProps, name: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should reject dangerous queries', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro({ ...validProps, query: 'TRUNCATE TABLE users' }, state);
      expect(result.success).toBe(false);
    });
  });

  // ── Connection lookup ─────────────────────────────────────────

  describe('connection', () => {
    it('should fail when connection is not found', async () => {
      const state = createMockState({ connections: [] });
      const result = await MsSqlMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when connection variant is wrong', async () => {
      const state = createMockState({
        connections: [{
          name: 'test-mssql',
          settingType: 'connection',
          data: { variant: 'postgres', host: 'h', port: 5432, database: 'd', username: 'u', password: 'p' },
        }],
      });
      const result = await MsSqlMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a MSSQL connection');
    });
  });

  // ── Query execution ───────────────────────────────────────────

  describe('query execution', () => {
    it('should execute query and return structured results', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro(validProps, state);

      expect(result.success).toBe(true);
      expect(result.tool).toBe('mssql');
      expect(result.data!.variant).toBe('mssql');
      expect(result.data!.result.rowCount).toBe(2);
      expect(result.data!.result.rows).toEqual(MSSQL_RESULT.recordset);
      expect(result.data!.result.columns).toEqual(['id', 'name']);
      expect(result.instructions).toContain('MSSQL Query Results');
    });
  });

  // ── Caching ───────────────────────────────────────────────────

  describe('caching', () => {
    it('should cache results and return cached on second call', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });

      const first = await MsSqlMacro({ ...validProps, cache: true }, state);
      expect(first.data!.cached).toBe(false);

      const second = await MsSqlMacro({ ...validProps, cache: true }, state);
      expect(second.success).toBe(true);
      expect(second.data!.cached).toBe(true);
      expect(second.instructions).toContain('Cached');
    });
  });

  // ── State storage ─────────────────────────────────────────────

  describe('state storage', () => {
    it('should store lastMsSqlQuery in state.vars', async () => {
      const state = createMockState({ connections: [mssqlConnection()] });
      await MsSqlMacro(validProps, state);

      expect(state.vars.lastMsSqlQuery).toBeDefined();
      expect(state.vars.lastMsSqlQuery.name).toBe('User List');
      expect(state.vars.lastMsSqlQuery.connectionId).toBe('test-mssql');
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when query execution fails', async () => {
      mockMssqlQuery.mockRejectedValue(new Error('Invalid column name'));
      const state = createMockState({ connections: [mssqlConnection()] });
      const result = await MsSqlMacro(validProps, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid column name');
      expect(mockMssqlClose).toHaveBeenCalled();
    });
  });

  // ── Registry ──────────────────────────────────────────────────

  describe('registry', () => {
    it('should have exactly one tool definition', () => {
      expect(MsSqlMacroRegistry.tools).toHaveLength(1);
      expect(MsSqlMacroRegistry.tools[0].function.name).toBe('mssql');
      expect(MsSqlMacroRegistry.tools[0].function.parameters.required).toEqual(['connectionId', 'query', 'name']);
    });

    it('should have correct metadata', () => {
      expect(MsSqlMacroRegistry.name).toBe('mssql');
      expect(MsSqlMacroRegistry.nameSpace).toBe('reactor-macros');
      expect(MsSqlMacroRegistry.component).toBe(MsSqlMacro);
    });
  });
});
