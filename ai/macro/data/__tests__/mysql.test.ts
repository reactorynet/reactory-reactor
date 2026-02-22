const mockMysqlExecute = jest.fn();
const mockMysqlEnd = jest.fn();

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn().mockResolvedValue({
    execute: mockMysqlExecute,
    end: mockMysqlEnd,
  }),
}));

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { MySqlMacro, MySqlMacroRegistry } from '../mysql/macro';
import { createMockState, mysqlConnection } from './support/mockState';

// mysql2 returns [rows, fields] from execute()
const MYSQL_ROWS = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
const MYSQL_FIELDS = [{ name: 'id' }, { name: 'name' }];
const MYSQL_RESULT: [any[], any[]] = [MYSQL_ROWS, MYSQL_FIELDS];

describe('MySqlMacro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMysqlEnd.mockResolvedValue(undefined);
    mockMysqlExecute.mockResolvedValue(MYSQL_RESULT);
  });

  const validProps = {
    connectionId: 'test-mysql',
    query: 'SELECT * FROM users',
    name: 'User List',
  };

  // ── Validation ──────────────────────────────────────────────

  describe('validation', () => {
    it('should fail when connectionId is missing', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro({ ...validProps, connectionId: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection ID');
    });

    it('should fail when query is missing', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro({ ...validProps, query: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Query');
    });

    it('should fail when name is missing', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro({ ...validProps, name: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should reject non-SELECT queries', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro({ ...validProps, query: 'DELETE FROM users WHERE 1=1' }, state);
      expect(result.success).toBe(false);
    });
  });

  // ── Connection lookup ─────────────────────────────────────────

  describe('connection', () => {
    it('should fail when connection is not found', async () => {
      const state = createMockState({ connections: [] });
      const result = await MySqlMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when connection variant is wrong', async () => {
      const state = createMockState({
        connections: [{
          name: 'test-mysql',
          settingType: 'connection',
          data: { variant: 'postgres', host: 'h', port: 5432, database: 'd', username: 'u', password: 'p' },
        }],
      });
      const result = await MySqlMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a MySQL connection');
    });
  });

  // ── Query execution ───────────────────────────────────────────

  describe('query execution', () => {
    it('should execute query and return structured results', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro(validProps, state);

      expect(result.success).toBe(true);
      expect(result.tool).toBe('mysql');
      expect(result.data!.variant).toBe('mysql');
      expect(result.data!.result.rowCount).toBe(2);
      expect(result.data!.result.rows).toEqual(MYSQL_ROWS);
      expect(result.data!.formattedOutput).toBeDefined();
      expect(result.instructions).toContain('MySQL Query Results');
    });

    it('should pass connection config to mysql2 createConnection', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      await MySqlMacro(validProps, state);

      const mysql2 = require('mysql2/promise');
      expect(mysql2.createConnection).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 3306,
        database: 'testdb',
        user: 'user',
        password: 'pass',
      }));
    });
  });

  // ── Caching ───────────────────────────────────────────────────

  describe('caching', () => {
    it('should return cached results on second call', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });

      const first = await MySqlMacro({ ...validProps, cache: true }, state);
      expect(first.data!.cached).toBe(false);

      const second = await MySqlMacro({ ...validProps, cache: true }, state);
      expect(second.success).toBe(true);
      expect(second.data!.cached).toBe(true);
    });
  });

  // ── State storage ─────────────────────────────────────────────

  describe('state storage', () => {
    it('should store lastMySqlQuery in state.vars', async () => {
      const state = createMockState({ connections: [mysqlConnection()] });
      await MySqlMacro(validProps, state);

      expect(state.vars.lastMySqlQuery).toBeDefined();
      expect(state.vars.lastMySqlQuery.name).toBe('User List');
      expect(state.vars.lastMySqlQuery.connectionId).toBe('test-mysql');
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when query execution fails', async () => {
      mockMysqlExecute.mockRejectedValue(new Error('Table not found'));
      const state = createMockState({ connections: [mysqlConnection()] });
      const result = await MySqlMacro(validProps, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Table not found');
      expect(mockMysqlEnd).toHaveBeenCalled();
    });
  });

  // ── Registry ──────────────────────────────────────────────────

  describe('registry', () => {
    it('should have exactly one tool definition with correct required params', () => {
      expect(MySqlMacroRegistry.tools).toHaveLength(1);
      expect(MySqlMacroRegistry.tools[0].function.name).toBe('mysql');
      expect(MySqlMacroRegistry.tools[0].function.parameters.required).toEqual(['connectionId', 'query', 'name']);
    });

    it('should have correct metadata', () => {
      expect(MySqlMacroRegistry.name).toBe('mysql');
      expect(MySqlMacroRegistry.nameSpace).toBe('reactor-macros');
      expect(MySqlMacroRegistry.component).toBe(MySqlMacro);
    });
  });
});
