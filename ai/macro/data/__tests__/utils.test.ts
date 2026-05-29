jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  getDatabaseConnection,
  formatQueryResults,
  validateQuery,
  createQueryResult,
  generateCacheKey,
  saveToFile,
} from '../utils';
import { DatabaseQueryResult } from '../types';

// ── getDatabaseConnection ───────────────────────────────────────

describe('getDatabaseConnection', () => {
  it('should return connection data when found', () => {
    const partner = {
      settings: [
        {
          name: 'my-db',
          settingType: 'connection',
          variant: 'postgres',
          data: { host: 'localhost', port: 5432, database: 'db', username: 'u', password: 'p' },
        },
      ],
    };
    const result = getDatabaseConnection('my-db', partner);
    expect(result).toEqual(
      expect.objectContaining({ variant: 'postgres', host: 'localhost' })
    );
  });

  it('should support legacy settingType + data.variant shape', () => {
    const partner = {
      settings: [
        {
          name: 'legacy-db',
          settingType: 'connection',
          data: { variant: 'postgres', host: 'localhost' },
        },
      ],
    };
    const result = getDatabaseConnection('legacy-db', partner);
    expect(result).toEqual(expect.objectContaining({ variant: 'postgres', host: 'localhost' }));
  });

  it('should return null when partner is null', () => {
    expect(getDatabaseConnection('my-db', null)).toBeNull();
  });

  it('should return null when partner has no settings array', () => {
    expect(getDatabaseConnection('my-db', {})).toBeNull();
    expect(getDatabaseConnection('my-db', { settings: 'not-array' })).toBeNull();
  });

  it('should return null when connectionId is not found', () => {
    const partner = {
      settings: [
        { name: 'other-db', settingType: 'connection', data: { variant: 'postgres' } },
      ],
    };
    expect(getDatabaseConnection('my-db', partner)).toBeNull();
  });

  it('should not match settings with a different settingType', () => {
    const partner = {
      settings: [
        { name: 'my-db', settingType: 'credential', data: { variant: 'postgres' } },
      ],
    };
    expect(getDatabaseConnection('my-db', partner)).toBeNull();
  });

  it('should return null when variant cannot be resolved', () => {
    const partner = {
      settings: [
        { name: 'my-db', settingType: 'connection', data: { host: 'localhost' } },
      ],
    };
    expect(getDatabaseConnection('my-db', partner)).toBeNull();
  });
});

// ── validateQuery ───────────────────────────────────────────────

describe('validateQuery', () => {
  it('should accept a simple SELECT query', () => {
    expect(validateQuery('SELECT * FROM users')).toEqual({ valid: true });
  });

  it('should accept SELECT with joins and subqueries', () => {
    expect(validateQuery('SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id')).toEqual({ valid: true });
  });

  it('should be case-insensitive for SELECT', () => {
    expect(validateQuery('select id from users')).toEqual({ valid: true });
    expect(validateQuery('Select * From users')).toEqual({ valid: true });
  });

  it('should reject non-SELECT queries', () => {
    const result = validateQuery('INSERT INTO users (name) VALUES (\'test\')');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('SELECT');
  });

  it.each([
    'DROP TABLE users',
    'DROP DATABASE mydb',
    'TRUNCATE TABLE users',
    'ALTER TABLE users ADD COLUMN x INT',
    'CREATE TABLE t (id INT)',
    'CREATE DATABASE newdb',
    'GRANT ALL ON users TO hacker',
    'REVOKE ALL ON users FROM admin',
    'BACKUP DATABASE mydb',
    'RESTORE DATABASE mydb',
  ])('should reject dangerous query: %s', (query) => {
    expect(validateQuery(query).valid).toBe(false);
  });
});

// ── createQueryResult ───────────────────────────────────────────

describe('createQueryResult', () => {
  it('should handle an array of objects (MySQL/generic format)', () => {
    const raw = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    const result = createQueryResult(raw, 10, true);

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual(raw);
    expect(result.executionTime).toBe(10);
  });

  it('should handle PostgreSQL format (rows + fields)', () => {
    const raw = {
      rows: [{ id: 1, name: 'Alice' }],
      fields: [{ name: 'id' }, { name: 'name' }],
    };
    const result = createQueryResult(raw, 5, true);

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual(raw.rows);
  });

  it('should handle MSSQL format (recordset)', () => {
    const raw = { recordset: [{ id: 1, name: 'Alice' }] };
    const result = createQueryResult(raw, 8, true);

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual(raw.recordset);
  });

  it('should return empty result on failure', () => {
    const result = createQueryResult(null, 1, false, 'DB error');

    expect(result.success).toBe(false);
    expect(result.rowCount).toBe(0);
    expect(result.columns).toEqual([]);
    expect(result.error).toBe('DB error');
  });

  it('should handle empty array', () => {
    const result = createQueryResult([], 2, true);

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(0);
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});

// ── formatQueryResults ──────────────────────────────────────────

describe('formatQueryResults', () => {
  const sampleResult: DatabaseQueryResult = {
    executionTime: 10,
    rowCount: 2,
    columns: ['id', 'name'],
    rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    raw: null,
    success: true,
  };

  it('should format as JSON', () => {
    const output = formatQueryResults(sampleResult, 'json', 'Test');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('Alice');
  });

  it('should format as CSV with headers', () => {
    const output = formatQueryResults(sampleResult, 'csv', 'Test');
    const lines = output.split('\n');
    expect(lines[0]).toBe('id,name');
    expect(lines[1]).toBe('1,Alice');
    expect(lines[2]).toBe('2,Bob');
  });

  it('should escape commas and quotes in CSV', () => {
    const result: DatabaseQueryResult = {
      ...sampleResult,
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'O\'Brien, "the great"' }],
      rowCount: 1,
    };
    const output = formatQueryResults(result, 'csv', 'Test');
    expect(output).toContain('"O\'Brien, ""the great"""');
  });

  it('should format as markdown table', () => {
    const output = formatQueryResults(sampleResult, 'markdown', 'Test');
    expect(output).toContain('# Test');
    expect(output).toContain('| id | name |');
    expect(output).toContain('| --- | --- |');
    expect(output).toContain('| 1 | Alice |');
  });

  it('should format as text', () => {
    const output = formatQueryResults(sampleResult, 'text', 'Test');
    expect(output).toContain('Test:');
    expect(output).toContain('Row 1:');
    expect(output).toContain('id: 1');
    expect(output).toContain('name: Alice');
  });

  it('should handle empty results gracefully', () => {
    const empty: DatabaseQueryResult = { ...sampleResult, rowCount: 0, rows: [] };
    expect(formatQueryResults(empty, 'csv', 'T')).toBe('');
    expect(formatQueryResults(empty, 'markdown', 'T')).toContain('No results');
    expect(formatQueryResults(empty, 'text', 'T')).toContain('No results');
  });
});

// ── generateCacheKey ────────────────────────────────────────────

describe('generateCacheKey', () => {
  it('should return a deterministic key', () => {
    const key1 = generateCacheKey('conn1', 'SELECT 1', 'test');
    const key2 = generateCacheKey('conn1', 'SELECT 1', 'test');
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^db_query_[a-f0-9]{32}$/);
  });

  it('should return different keys for different inputs', () => {
    const key1 = generateCacheKey('conn1', 'SELECT 1', 'test');
    const key2 = generateCacheKey('conn1', 'SELECT 2', 'test');
    const key3 = generateCacheKey('conn2', 'SELECT 1', 'test');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

// ── saveToFile ──────────────────────────────────────────────────

describe('saveToFile', () => {
  const fsMock = require('fs').promises;

  beforeEach(() => {
    jest.clearAllMocks();
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
  });

  it('should write file and return success with file path', async () => {
    const result = await saveToFile('data content', 'my-report', 'csv', 'user-1');

    expect(result.success).toBe(true);
    expect(result.filePath).toContain('my-report');
    expect(result.filePath).toContain('.csv');
    expect(fsMock.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('user-1'),
      { recursive: true },
    );
    expect(fsMock.writeFile).toHaveBeenCalled();
  });

  it('should use .md extension for markdown format', async () => {
    const result = await saveToFile('# Report', 'report', 'markdown', 'user-1');
    expect(result.filePath).toContain('.md');
  });

  it('should return error when write fails', async () => {
    fsMock.writeFile.mockRejectedValueOnce(new Error('Disk full'));
    const result = await saveToFile('data', 'report', 'json', 'user-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Disk full');
  });
});
