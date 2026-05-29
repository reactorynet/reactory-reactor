jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { listDatabaseConnections } from '../utils';
import {
  ListDataConnectionsMacro,
  ListDataConnectionsMacroRegistry,
} from '../connections/macro';
import { createMockState } from './support/mockState';

const buildPartner = () => ({
  settings: [
    {
      name: 'pg-public',
      settingType: 'connection',
      variant: 'postgres',
      data: {
        host: 'localhost',
        port: 5432,
        database: 'analytics',
        username: 'postgres',
        password: 'secret',
      },
    },
    {
      name: 'mongo-admin',
      settingType: 'connection',
      variant: 'mongo',
      roles: ['ADMIN'],
      data: {
        host: 'localhost',
        port: 27017,
        database: 'admin-db',
        username: 'mongo',
        password: 'secret',
      },
    },
    {
      name: 'legacy-mssql',
      settingType: 'connection',
      data: {
        variant: 'mssql',
        host: 'localhost',
        port: 1433,
        database: 'legacy-db',
      },
    },
    {
      name: 'not-a-connection',
      settingType: 'credential',
      data: { variant: 'postgres' },
    },
  ],
});

describe('listDatabaseConnections utility', () => {
  it('returns only connection settings and sanitizes secrets', () => {
    const result = listDatabaseConnections(buildPartner(), () => true);

    expect(result).toHaveLength(3);
    expect(result[0].connectionId).toBe('pg-public');
    expect((result[0] as any).password).toBeUndefined();
    expect((result[0] as any).username).toBeUndefined();
  });

  it('filters role-protected settings when role checker denies access', () => {
    const result = listDatabaseConnections(buildPartner(), (roles) => roles.includes('USER'));

    expect(result).toHaveLength(2);
    expect(result[0].connectionId).toBe('pg-public');
  });

  it('denies role-protected settings when no role checker is provided', () => {
    const result = listDatabaseConnections(buildPartner());

    expect(result).toHaveLength(2);
    expect(result[0].connectionId).toBe('pg-public');
  });
});

describe('ListDataConnectionsMacro', () => {
  it('returns an error when partner context is missing', async () => {
    const state = createMockState();
    (state as any).context.partner = undefined;

    const result = await ListDataConnectionsMacro({}, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Partner context');
  });

  it('returns unrestricted and authorized role-protected connections', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn((roles: string[]) => roles.includes('ADMIN'));

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
    expect(result.data?.connections.map((c) => c.connectionId)).toEqual(
      expect.arrayContaining(['pg-public', 'mongo-admin', 'legacy-mssql'])
    );
    expect((result.data?.connections[0] as any).password).toBeUndefined();
  });

  it('filters out unauthorized role-protected connections', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn(() => false);

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2);
    expect(result.data?.connections[0].connectionId).toBe('pg-public');
  });

  it('falls back to state.user roles when context.hasAnyRole is unavailable', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    delete (state as any).context.hasAnyRole;
    (state as any).user = {
      activeMembership: {
        roles: ['ADMIN'],
      },
    };

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
  });

  it('falls back to context.user roles when context.hasAnyRole is unavailable', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    delete (state as any).context.hasAnyRole;
    (state as any).context.user = {
      roles: ['ADMIN'],
    };
    (state as any).user = undefined;

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
  });

  it('supports memberships role fallback when role helper is unavailable', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    delete (state as any).context.hasAnyRole;
    (state as any).user = {
      memberships: [{ roles: ['ADMIN'] }],
    };

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
  });

  it('denies role-protected settings in fallback mode when user has no roles', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    delete (state as any).context.hasAnyRole;
    (state as any).user = {};

    const result = await ListDataConnectionsMacro({}, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2);
    expect(result.data?.connections[0].connectionId).toBe('pg-public');
  });

  it('supports single variant filter', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn(() => true);

    const result = await ListDataConnectionsMacro({ variant: 'mongo' }, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    expect(result.data?.connections[0].variant).toBe('mongo');
  });

  it('supports variants array filter', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn(() => true);

    const result = await ListDataConnectionsMacro({ variants: ['postgres'] }, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    expect(result.data?.connections[0].variant).toBe('postgres');
  });

  it('applies variant filter correctly on settings.ts shape', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn(() => true);

    const result = await ListDataConnectionsMacro({ variant: 'mssql' }, state);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    expect(result.data?.connections[0]).toEqual(
      expect.objectContaining({ connectionId: 'legacy-mssql', variant: 'mssql' })
    );
  });

  it('supports union filtering when variant and variants are both provided', async () => {
    const state = createMockState();
    (state as any).context.partner = buildPartner();
    (state as any).context.hasAnyRole = jest.fn(() => true);

    const result = await ListDataConnectionsMacro(
      { variant: 'postgres', variants: ['mongo'] },
      state,
    );

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2);
    expect(result.data?.variants.sort()).toEqual(['mongo', 'postgres']);
  });
});

describe('ListDataConnectionsMacro registry', () => {
  it('has expected macro metadata', () => {
    expect(ListDataConnectionsMacroRegistry.name).toBe('listDataConnections');
    expect(ListDataConnectionsMacroRegistry.nameSpace).toBe('reactor-macros');
    expect(ListDataConnectionsMacroRegistry.component).toBe(ListDataConnectionsMacro);
  });

  it('exposes one function tool named listDataConnections', () => {
    expect(ListDataConnectionsMacroRegistry.tools).toHaveLength(1);
    expect(ListDataConnectionsMacroRegistry.tools?.[0].function.name).toBe('listDataConnections');
  });
});
