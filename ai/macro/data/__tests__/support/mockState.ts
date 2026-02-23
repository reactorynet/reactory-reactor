import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

interface ConnectionConfig {
  name: string;
  settingType: string;
  data: {
    variant: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    options?: Record<string, any>;
  };
}

interface MockStateOptions {
  vars?: Record<string, any>;
  connections?: ConnectionConfig[];
  userId?: string;
  services?: Record<string, any>;
}

/**
 * Create a lightweight ChatState mock for data macro tests.
 * Unlike the existing `data/tests/mocks/ChatState.ts`, this does NOT
 * depend on ReactoryContextProvider or any heavy server bootstrap,
 * making it safe to use in unit tests without OPENAI_API_KEY, etc.
 */
export function createMockState(options: MockStateOptions = {}): ChatState {
  const {
    vars = {},
    connections = [],
    userId = 'test-user-123',
    services = {},
  } = options;

  return {
    personaId: 'test-persona',
    modelId: 'gpt-4',
    started: new Date(),
    history: [],
    macros: [],
    vars,
    user: { id: userId } as any,
    context: {
      partner: {
        settings: connections.map(c => ({
          name: c.name,
          settingType: c.settingType,
          data: c.data,
        })),
      },
      getService: jest.fn((fqn: string) => services[fqn] || null),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any,
  } as any;
}

export function pgConnection(id = 'test-pg'): ConnectionConfig {
  return {
    name: id,
    settingType: 'connection',
    data: { variant: 'postgres', host: 'localhost', port: 5432, database: 'testdb', username: 'user', password: 'pass' },
  };
}

export function mysqlConnection(id = 'test-mysql'): ConnectionConfig {
  return {
    name: id,
    settingType: 'connection',
    data: { variant: 'mysql', host: 'localhost', port: 3306, database: 'testdb', username: 'user', password: 'pass' },
  };
}

export function mssqlConnection(id = 'test-mssql'): ConnectionConfig {
  return {
    name: id,
    settingType: 'connection',
    data: { variant: 'mssql', host: 'localhost', port: 1433, database: 'testdb', username: 'user', password: 'pass' },
  };
}

export function mongoConnection(id = 'test-mongo'): ConnectionConfig {
  return {
    name: id,
    settingType: 'connection',
    data: { variant: 'mongo', host: 'localhost', port: 27017, database: 'testdb', username: 'user', password: 'pass' },
  };
}
