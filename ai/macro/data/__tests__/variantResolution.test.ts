/**
 * Variant resolution — regression suite for REACTORY-302016408/20261103/3664951717.
 *
 * The defect these tests exist for: `reactory.mongodb.connection` declares
 * `variant: "mongodb"`, while every data macro compared the value strictly
 * against `'mongo'`. A correctly-declared connection was therefore rejected
 * every time, and the error message echoed "mongodb" back as the reason it was
 * "not a MongoDB connection". The `mongo` macro was unusable and the only
 * workaround was a shell script against the raw URI, bypassing the macro's
 * access control and redaction.
 *
 * The durable fix is the alias table in ../variants.ts plus these tests. A
 * future rename of a variant — on either side, the setting or the macro — now
 * fails here instead of silently disabling a tool.
 */
const mockMongoToArray = jest.fn();
const mockMongoInsertOne = jest.fn();
const mockMongoClientClose = jest.fn();
const mockMongoClientConnect = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn(() => ({
    connect: mockMongoClientConnect,
    close: mockMongoClientClose,
    db: jest.fn(() => ({
      collection: jest.fn(() => ({
        find: jest.fn(() => {
          const cursor: any = { toArray: mockMongoToArray };
          cursor.sort = jest.fn(() => cursor);
          cursor.skip = jest.fn(() => cursor);
          cursor.limit = jest.fn(() => cursor);
          return cursor;
        }),
        aggregate: jest.fn(() => ({ toArray: mockMongoToArray })),
        insertOne: mockMongoInsertOne,
      })),
    })),
  })),
}));

const mockPgConnect = jest.fn();
const mockPgQuery = jest.fn();
const mockPgEnd = jest.fn();

jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    connect: mockPgConnect,
    query: mockPgQuery,
    end: mockPgEnd,
  })),
}));

const mockMssqlQuery = jest.fn();
const mockMssqlClose = jest.fn();

jest.mock('mssql', () => ({
  ConnectionPool: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue({
      request: () => ({ query: mockMssqlQuery }),
      close: mockMssqlClose,
    }),
  })),
}));

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

import { MongoReadMacro, MongoReadMacroRegistry, MongoWriteMacro } from '../mongo/macro';
import { PostgresMacro, PostgresMacroRegistry } from '../pgsql/macro';
import { MySqlMacro, MySqlMacroRegistry } from '../mysql/macro';
import { MsSqlMacro, MsSqlMacroRegistry } from '../mssql/macro';
import { ListDataConnectionsMacro } from '../connections/macro';
import { getDatabaseConnection, listDatabaseConnections } from '../utils';
import {
  DATABASE_VARIANTS,
  isDatabaseVariant,
  normaliseDatabaseVariant,
} from '../variants';
import { DatabaseVariant } from '../types';
import { createMockState } from './support/mockState';

const MONGO_DB = 'reactory-reactory';

/** A partner setting shaped exactly like the ones in clientConfigs settings.ts. */
const connectionSetting = (overrides: Record<string, any> = {}) => ({
  name: 'reactory.mongodb.connection',
  settingType: 'connection',
  variant: 'mongodb',
  roles: ['ADMIN'],
  data: {
    host: 'localhost',
    port: 27017,
    database: MONGO_DB,
    username: 'reactory',
    password: 'secret',
  },
  ...overrides,
});

/**
 * Build a chat state whose partner carries the supplied settings verbatim.
 * Role checks pass, because the settings in this suite are ADMIN-scoped and the
 * subject under test is variant resolution, not access control.
 */
const stateWith = (settings: any[]) => {
  const state: any = createMockState();
  state.context.partner = { settings };
  state.context.hasAnyRole = jest.fn(() => true);
  return state;
};

const otherConnection = (variant: string) => ({
  name: 'pg-public',
  settingType: 'connection',
  variant,
  data: { host: 'localhost', port: 5432, database: 'reactory', username: 'u', password: 'p' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMongoClientConnect.mockResolvedValue(undefined);
  mockMongoClientClose.mockResolvedValue(undefined);
  mockMongoToArray.mockResolvedValue([]);
  mockMongoInsertOne.mockResolvedValue({ insertedId: 'abc', acknowledged: true });
  mockPgConnect.mockResolvedValue(undefined);
  mockPgEnd.mockResolvedValue(undefined);
  mockPgQuery.mockResolvedValue({ rows: [{ id: 1 }], fields: [{ name: 'id' }] });
  mockMssqlQuery.mockResolvedValue({ recordset: [{ id: 1 }], rowsAffected: [1] });
  mockMssqlClose.mockResolvedValue(undefined);
  mockMysqlExecute.mockResolvedValue([[{ id: 1 }], [{ name: 'id' }]]);
  mockMysqlEnd.mockResolvedValue(undefined);
});

describe('normaliseDatabaseVariant', () => {
  it('accepts every canonical variant unchanged', () => {
    DATABASE_VARIANTS.forEach((variant) => {
      expect(normaliseDatabaseVariant(variant)).toBe(variant);
    });
  });

  it('resolves the mongodb spelling that the client config actually declares', () => {
    // This is the defect: 'mongodb' never matched 'mongo'.
    expect(normaliseDatabaseVariant('mongodb')).toBe('mongo');
    expect(isDatabaseVariant('mongodb', 'mongo')).toBe(true);
  });

  it('continues to accept the canonical mongo spelling', () => {
    // ...and the fix must NOT be a literal flip, because 'mongo' is the
    // documented value and appears in existing settings.
    expect(normaliseDatabaseVariant('mongo')).toBe('mongo');
    expect(isDatabaseVariant('mongo', 'mongo')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normaliseDatabaseVariant(' MongoDB ')).toBe('mongo');
    expect(normaliseDatabaseVariant('PostgreSQL')).toBe('postgres');
  });

  it('resolves the other documented synonyms', () => {
    expect(normaliseDatabaseVariant('postgresql')).toBe('postgres');
    expect(normaliseDatabaseVariant('sqlserver')).toBe('mssql');
  });

  it('returns undefined for values that are not database variants', () => {
    expect(normaliseDatabaseVariant('prometheus')).toBeUndefined();
    expect(normaliseDatabaseVariant('')).toBeUndefined();
    expect(normaliseDatabaseVariant('   ')).toBeUndefined();
    expect(normaliseDatabaseVariant(undefined)).toBeUndefined();
    expect(normaliseDatabaseVariant(null)).toBeUndefined();
    expect(normaliseDatabaseVariant(42)).toBeUndefined();
  });

  it('does not treat a different stored variant as one of ours', () => {
    expect(isDatabaseVariant('mongodb', 'postgres')).toBe(false);
    expect(isDatabaseVariant('mssql', 'mongo')).toBe(false);
  });
});

describe('getDatabaseConnection', () => {
  it('normalises a variant declared on the setting', () => {
    const partner = { settings: [connectionSetting()] };
    const connection = getDatabaseConnection('reactory.mongodb.connection', partner);

    expect(connection).not.toBeNull();
    expect(connection?.variant).toBe('mongo');
    expect(connection?.database).toBe(MONGO_DB);
  });

  it('normalises a variant declared inside data', () => {
    const partner = {
      settings: [
        connectionSetting({
          variant: undefined,
          data: { ...connectionSetting().data, variant: 'mongodb' },
        }),
      ],
    };

    expect(getDatabaseConnection('reactory.mongodb.connection', partner)?.variant).toBe('mongo');
  });

  it('passes non-database variants through unchanged', () => {
    const partner = {
      settings: [
        {
          name: 'reactory.prometheus.connection',
          settingType: 'connection',
          variant: 'prometheus',
          data: { host: 'localhost', port: 9090 },
        },
      ],
    };

    expect(getDatabaseConnection('reactory.prometheus.connection', partner)?.variant)
      .toBe('prometheus');
  });
});

describe('listDatabaseConnections', () => {
  it('advertises the spelling the macro accepts, not the spelling that was declared', () => {
    const listed = listDatabaseConnections({ settings: [connectionSetting()] }, () => true);

    expect(listed).toHaveLength(1);
    expect(listed[0].connectionId).toBe('reactory.mongodb.connection');
    // Declared as 'mongodb'; advertised as 'mongo' so the listing and the macro
    // cannot disagree about the same connection.
    expect(listed[0].variant).toBe('mongo');
    expect((listed[0] as any).password).toBeUndefined();
  });

  it('still lists non-database connections', () => {
    const listed = listDatabaseConnections(
      {
        settings: [
          connectionSetting(),
          {
            name: 'reactory.prometheus.connection',
            settingType: 'connection',
            variant: 'prometheus',
            data: { host: 'localhost', port: 9090 },
          },
        ],
      },
      () => true,
    );

    expect(listed.map((c) => c.connectionId)).toEqual([
      'reactory.mongodb.connection',
      'reactory.prometheus.connection',
    ]);
  });
});

describe('mongo macro accepts the declared mongodb variant', () => {
  it('runs a read against a connection declared as mongodb', async () => {
    const state = stateWith([connectionSetting()]);

    const result = await MongoReadMacro(
      {
        connectionId: 'reactory.mongodb.connection',
        collection: 'reactory_templates',
        filter: {},
        name: 'List templates',
      },
      state,
    );

    // Before the fix this returned
    // "Connection '...' is not a MongoDB connection (variant: mongodb)".
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockMongoClientConnect).toHaveBeenCalledTimes(1);
    expect(mockMongoToArray).toHaveBeenCalledTimes(1);
  });

  it('runs a write against a connection declared as mongodb', async () => {
    const state = stateWith([connectionSetting()]);

    const result = await MongoWriteMacro(
      {
        connectionId: 'reactory.mongodb.connection',
        collection: 'reactory_templates',
        writeOperation: 'insertOne',
        document: { name: 'welcome' },
        name: 'Seed template',
      },
      state,
    );

    expect(result.success).toBe(true);
    expect(mockMongoInsertOne).toHaveBeenCalledTimes(1);
  });

  it('still rejects a connection that is genuinely not MongoDB', async () => {
    const state = stateWith([otherConnection('postgres')]);

    const result = await MongoReadMacro(
      {
        connectionId: 'pg-public',
        collection: 'reactory_templates',
        filter: {},
        name: 'Wrong tool',
      },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('is not a MongoDB connection');
    expect(mockMongoClientConnect).not.toHaveBeenCalled();
  });

  it('accepts the canonical mongo spelling as well', async () => {
    const state = stateWith([otherConnection('mongo')]);

    const result = await MongoReadMacro(
      { connectionId: 'pg-public', collection: 'c', filter: {}, name: 'canonical' },
      state,
    );

    expect(result.success).toBe(true);
  });
});

describe('sibling data macros resolve their declared variants', () => {
  it('postgres accepts the postgresql spelling', async () => {
    const state = stateWith([otherConnection('postgresql')]);

    const result = await PostgresMacro(
      { connectionId: 'pg-public', query: 'SELECT 1', name: 'alias' },
      state,
    );

    expect(result.success).toBe(true);
    expect(mockPgConnect).toHaveBeenCalledTimes(1);
  });

  it('postgres still rejects a mongo connection', async () => {
    const state = stateWith([connectionSetting()]);

    const result = await PostgresMacro(
      { connectionId: 'reactory.mongodb.connection', query: 'SELECT 1', name: 'wrong' },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('is not a PostgreSQL connection');
    expect(mockPgConnect).not.toHaveBeenCalled();
  });

  it('mssql accepts the sqlserver spelling', async () => {
    const state = stateWith([
      {
        name: 'legacy-mssql',
        settingType: 'connection',
        variant: 'sqlserver',
        data: { host: 'localhost', port: 1433, database: 'legacy', username: 'u', password: 'p' },
      },
    ]);

    const result = await MsSqlMacro(
      { connectionId: 'legacy-mssql', query: 'SELECT 1', name: 'alias' },
      state,
    );

    expect(result.success).toBe(true);
    expect(mockMssqlQuery).toHaveBeenCalledTimes(1);
  });

  it('mysql continues to accept its canonical spelling', async () => {
    const state = stateWith([otherConnection('mysql')]);

    const result = await MySqlMacro(
      { connectionId: 'pg-public', query: 'SELECT 1', name: 'canonical' },
      state,
    );

    expect(result.success).toBe(true);
    expect(mockMysqlExecute).toHaveBeenCalledTimes(1);
  });
});

describe('listDataConnections variant filter', () => {
  it('matches a mongodb setting when filtered by the canonical mongo variant', async () => {
    const result = await ListDataConnectionsMacro({ variant: 'mongo' as DatabaseVariant }, stateWith([connectionSetting()]));

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    expect(result.data?.variants).toEqual(['mongo']);
  });

  it('matches a mongodb setting when filtered by the declared mongodb spelling', async () => {
    const result = await ListDataConnectionsMacro(
      { variant: 'mongodb' as DatabaseVariant },
      stateWith([connectionSetting()]),
    );

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
  });
});

describe('registry contract', () => {
  /**
   * The database connection variants the server's client config declares
   * (src/data/clientConfigs/reactory/settings/settings.ts). Pinned here so that
   * changing either side without the other fails this suite.
   */
  const DECLARED_BY_SERVER_REGISTRY: Array<[string, DatabaseVariant]> = [
    ['reactory.mongodb.connection', 'mongodb' as unknown as DatabaseVariant],
    ['reactory.postgres.connection', 'postgres'],
  ];

  const MACRO_REGISTRIES: Record<string, { name: string; tools?: any[] }> = {
    mongo: MongoReadMacroRegistry,
    postgres: PostgresMacroRegistry,
    mysql: MySqlMacroRegistry,
    mssql: MsSqlMacroRegistry,
  };

  it.each(DECLARED_BY_SERVER_REGISTRY)(
    '%s declares a variant that a macro accepts',
    (connectionId, declared) => {
      const canonical = normaliseDatabaseVariant(declared);

      expect(canonical).toBeDefined();

      const registry = MACRO_REGISTRIES[canonical as string];
      expect(registry).toBeDefined();
      expect(registry.tools?.[0].function.name).toBe(canonical);
    },
  );

  it('does not map two canonical variants onto the same tool name', () => {
    const toolNames = Object.values(MACRO_REGISTRIES).map((r) => r.tools?.[0].function.name);

    expect(new Set(toolNames).size).toBe(toolNames.length);
  });
});
