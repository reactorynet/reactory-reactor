const mockFind = jest.fn();
const mockAggregateToArray = jest.fn();
const mockCollection = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    db: () => ({ collection: mockCollection }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { MongoReadMacro } from '../mongo/macro';
import { createMockState, mongoConnection } from './support/mockState';

/**
 * The read-side denylist (ticket item 6).
 *
 * `mongo` accepts an arbitrary collection and an arbitrary projection, so it could read
 * `users` with no projection and return a User document complete with its PBKDF2
 * `password`, `salt`, `sessionInfo` refresh tokens and `authentications[].props.accessToken`
 * - straight into a tool result, the conversation and (via `saveToFile`) the workspace.
 *
 * The guard has two halves and this suite pins both:
 *  - the exclusion is applied to the query, so credential fields are never fetched for a
 *    user collection or for a find with no projection; and
 *  - rows are redacted after the read, which covers aggregation output and a caller's
 *    inclusion projection (MongoDB cannot mix an exclusion into those).
 */

const cursorFor = (rows: any[]) => {
  const cursor: any = {
    sort: jest.fn(() => cursor),
    skip: jest.fn(() => cursor),
    limit: jest.fn(() => cursor),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  return cursor;
};

const connectionState = () => createMockState({ connections: [mongoConnection('test-mongo')] });

// `query` is required by DatabaseMacroProps even though the mongo macro accepts a
// filter or a pipeline instead; an empty string keeps the type honest and is falsy.
const baseProps = {
  connectionId: 'test-mongo',
  name: 'read',
  format: 'json' as const,
  query: '',
};

describe('MongoReadMacro — credential read guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.mockImplementation(() => ({
      find: mockFind,
      aggregate: jest.fn(() => ({ toArray: mockAggregateToArray })),
    }));
  });

  it('excludes credential fields when a user collection is read with no projection', async () => {
    mockFind.mockReturnValue(cursorFor([{ _id: 'u1', email: 'ada@example.com' }]));

    await MongoReadMacro({ ...baseProps, collection: 'users', filter: {} }, connectionState());

    expect(mockFind).toHaveBeenCalledTimes(1);
    const projection = mockFind.mock.calls[0][1];
    expect(projection).toMatchObject({
      password: 0,
      salt: 0,
      sessionInfo: 0,
      authentications: 0,
      memberships: 0,
    });
  });

  it('recognises a tenant-qualified user collection name', async () => {
    mockFind.mockReturnValue(cursorFor([]));

    await MongoReadMacro(
      { ...baseProps, collection: 'core.reactory_users', filter: {} },
      connectionState()
    );

    expect(mockFind.mock.calls[0][1]).toMatchObject({ password: 0, salt: 0 });
  });

  it('excludes credential fields for a raw JSON query, which carries no projection', async () => {
    mockFind.mockReturnValue(cursorFor([{ _id: 'u1', email: 'ada@example.com' }]));

    await MongoReadMacro(
      { ...baseProps, collection: 'users', query: '{"email":"ada@example.com"}' },
      connectionState()
    );

    expect(mockFind.mock.calls[0][1]).toMatchObject({ password: 0, salt: 0 });
  });

  it('excludes credential fields for a find with no projection on any collection', async () => {
    mockFind.mockReturnValue(cursorFor([{ _id: 'm1' }]));

    await MongoReadMacro(
      { ...baseProps, collection: 'usage_metrics', filter: { kind: 'daily' } },
      connectionState()
    );

    expect(mockFind.mock.calls[0][1]).toMatchObject({ password: 0, salt: 0 });
  });

  it('passes a caller inclusion projection through unchanged and redacts the rows it returns', async () => {
    // A mixed projection cannot be combined with an exclusion in MongoDB, and a caller may
    // explicitly ask for a sensitive field - so the read is allowed and the result is scrubbed.
    const projection = { email: 1, password: 1 };
    mockFind.mockReturnValue(
      cursorFor([
        {
          email: 'ada@example.com',
          password: 'pbkdf2$10000$deadbeef$cafebabe',
          salt: 'salty-salt',
        },
      ])
    );

    const result = await MongoReadMacro(
      { ...baseProps, collection: 'users', filter: {}, projection },
      connectionState()
    );

    expect(mockFind.mock.calls[0][1]).toEqual(projection);

    const row = result.data?.result?.rows?.[0];
    expect(row.email).toBe('ada@example.com');
    expect(row.password).toBe('[REDACTED]');
    expect(row.salt).toBe('[REDACTED]');
    expect(JSON.stringify(result.data)).not.toContain('pbkdf2');
    expect(JSON.stringify(result.data)).not.toContain('salty-salt');
  });

  it('redacts credential fields in aggregation output before formatting', async () => {
    mockAggregateToArray.mockResolvedValue([
      { email: 'ada@example.com', password: 'pbkdf2$hash', refreshToken: 'refresh-token-value' },
    ]);

    const state = connectionState();
    const result = await MongoReadMacro(
      { ...baseProps, collection: 'users', pipeline: [{ $match: {} }] },
      state
    );

    const row = result.data?.result?.rows?.[0];
    expect(row.password).toBe('[REDACTED]');
    expect(row.refreshToken).toBe('[REDACTED]');
    expect(result.data?.formattedOutput).not.toContain('pbkdf2');
    expect(result.data?.formattedOutput).not.toContain('refresh-token-value');

    // The formatted output and the cached copy in state.vars are clean too - neither is
    // a place a caller would ever think to look for a leak.
    const persisted = JSON.stringify(state.vars);
    expect(persisted).not.toContain('pbkdf2');
    expect(persisted).not.toContain('refresh-token-value');
  });

  it('leaves an explicit exclusion projection on a non-user collection untouched', async () => {
    const projection = { internal: 0 };
    mockFind.mockReturnValue(cursorFor([{ _id: 'm1', kind: 'daily' }]));

    await MongoReadMacro(
      { ...baseProps, collection: 'usage_metrics', filter: {}, projection },
      connectionState()
    );

    expect(mockFind.mock.calls[0][1]).toEqual(projection);
  });
});
