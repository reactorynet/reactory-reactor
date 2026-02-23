const mockPgEnd = jest.fn();
const mockPgQuery = jest.fn();
const mockPgConnect = jest.fn();

jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    connect: mockPgConnect,
    query: mockPgQuery,
    end: mockPgEnd,
  })),
}));

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { PostgresMacro, PostgresMacroRegistry } from '../pgsql/macro';
import { createMockState, pgConnection } from './support/mockState';

const PG_RESULT = {
  rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  fields: [{ name: 'id' }, { name: 'name' }],
};

describe('PostgresMacro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPgConnect.mockResolvedValue(undefined);
    mockPgEnd.mockResolvedValue(undefined);
    mockPgQuery.mockResolvedValue(PG_RESULT);
  });

  const validProps = {
    connectionId: 'test-pg',
    query: 'SELECT * FROM users',
    name: 'User List',
  };

  // ── Validation ──────────────────────────────────────────────

  describe('validation', () => {
    it('should fail when connectionId is missing', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro({ ...validProps, connectionId: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection ID');
    });

    it('should fail when query is missing', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro({ ...validProps, query: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Query');
    });

    it('should fail when name is missing', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro({ ...validProps, name: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should reject non-SELECT queries', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro({ ...validProps, query: 'DROP TABLE users' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous');
    });
  });

  // ── Connection lookup ─────────────────────────────────────────

  describe('connection', () => {
    it('should fail when connection is not found in partner settings', async () => {
      const state = createMockState({ connections: [] });
      const result = await PostgresMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when connection variant does not match', async () => {
      const state = createMockState({
        connections: [{
          name: 'test-pg',
          settingType: 'connection',
          data: { variant: 'mysql', host: 'h', port: 3306, database: 'd', username: 'u', password: 'p' },
        }],
      });
      const result = await PostgresMacro(validProps, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a PostgreSQL connection');
    });
  });

  // ── Successful query ──────────────────────────────────────────

  describe('query execution', () => {
    it('should execute query and return structured results', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro(validProps, state);

      expect(result.success).toBe(true);
      expect(result.tool).toBe('postgres');
      expect(result.data).toBeDefined();
      expect(result.data!.variant).toBe('postgres');
      expect(result.data!.result.rowCount).toBe(2);
      expect(result.data!.result.columns).toEqual(['id', 'name']);
      expect(result.data!.formattedOutput).toBeDefined();
      expect(result.data!.name).toBe('User List');
      expect(result.data!.query).toBe('SELECT * FROM users');
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.rowCount).toBe(2);
      expect(result.metadata!.columnCount).toBe(2);
      expect(result.instructions).toContain('PostgreSQL Query Results');
    });

    it('should pass connection config to pg Client', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      await PostgresMacro(validProps, state);

      const { Client } = require('pg');
      expect(Client).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'user',
        password: 'pass',
      }));
      expect(mockPgConnect).toHaveBeenCalledTimes(1);
      expect(mockPgEnd).toHaveBeenCalledTimes(1);
    });

    it('should trim whitespace from connectionId, query, and name', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro(
        { connectionId: '  test-pg  ', query: '  SELECT 1  ', name: '  Trimmed  ' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.data!.connectionId).toBe('test-pg');
      expect(result.data!.query).toBe('SELECT 1');
      expect(result.data!.name).toBe('Trimmed');
    });
  });

  // ── Caching ───────────────────────────────────────────────────

  describe('caching', () => {
    it('should cache results in state.vars when cache is enabled', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro({ ...validProps, cache: true }, state);

      expect(result.success).toBe(true);
      expect(result.data!.cached).toBe(false);
      expect(result.data!.cacheKey).toBeDefined();
      const cacheKey = result.data!.cacheKey!;
      expect(state.vars[cacheKey]).toBeDefined();
      expect(state.vars[cacheKey].timestamp).toBeGreaterThan(0);
    });

    it('should return cached results on second call within 5 minutes', async () => {
      const state = createMockState({ connections: [pgConnection()] });

      const first = await PostgresMacro({ ...validProps, cache: true }, state);
      expect(first.success).toBe(true);

      const second = await PostgresMacro({ ...validProps, cache: true }, state);
      expect(second.success).toBe(true);
      expect(second.data!.cached).toBe(true);
      expect(second.instructions).toContain('Cached');

      // pg Client should only have been created once
      expect(mockPgConnect).toHaveBeenCalledTimes(1);
    });

    it('should skip cache when cache=false', async () => {
      const state = createMockState({ connections: [pgConnection()] });

      await PostgresMacro({ ...validProps, cache: true }, state);
      await PostgresMacro({ ...validProps, cache: false }, state);

      // Should have connected twice
      expect(mockPgConnect).toHaveBeenCalledTimes(2);
    });
  });

  // ── State storage ─────────────────────────────────────────────

  describe('state storage', () => {
    it('should store lastPostgresQuery in state.vars', async () => {
      const state = createMockState({ connections: [pgConnection()] });
      await PostgresMacro(validProps, state);

      expect(state.vars.lastPostgresQuery).toBeDefined();
      expect(state.vars.lastPostgresQuery.name).toBe('User List');
      expect(state.vars.lastPostgresQuery.query).toBe('SELECT * FROM users');
      expect(state.vars.lastPostgresQuery.connectionId).toBe('test-pg');
      expect(state.vars.lastPostgresQuery.result).toBeDefined();
      expect(state.vars.lastPostgresQuery.format).toBe('json');
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when query execution fails', async () => {
      mockPgQuery.mockRejectedValue(new Error('relation "users" does not exist'));
      const state = createMockState({ connections: [pgConnection()] });
      const result = await PostgresMacro(validProps, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('relation "users" does not exist');
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.executionTime).toBeGreaterThanOrEqual(0);
      // Connection should still be closed in finally block
      expect(mockPgEnd).toHaveBeenCalled();
    });
  });

  // ── Registry ──────────────────────────────────────────────────

  describe('registry', () => {
    it('should have exactly one tool definition', () => {
      expect(PostgresMacroRegistry.tools).toHaveLength(1);
      expect(PostgresMacroRegistry.tools[0].function.name).toBe('postgres');
      expect(PostgresMacroRegistry.tools[0].function.parameters.required).toEqual(['connectionId', 'query', 'name']);
    });

    it('should have correct metadata', () => {
      expect(PostgresMacroRegistry.name).toBe('postgres');
      expect(PostgresMacroRegistry.nameSpace).toBe('reactor-macros');
      expect(PostgresMacroRegistry.roles).toContain('DEVELOPER');
      expect(PostgresMacroRegistry.component).toBe(PostgresMacro);
    });
  });
});
