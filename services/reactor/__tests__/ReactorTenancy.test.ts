/**
 * WP-B2: the reactor message log and usage analytics are tenant-scoped.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import ReactorConversationMessageService from '../ReactorConversationMessageService';
import { TenantScopeError } from '@reactory/server-core/database/tenant/TenantRepository';

const liveDataSource = (overrides: Record<string, unknown> = {}) => ({
  isInitialized: true,
  getRepository: () => ({
    metadata: (global as any).testHelpers.tenantMetadata('ReactorConversationMessage'),
    query: jest.fn(async () => []),
  }),
  ...overrides,
}) as any;

describe('ReactorConversationMessageService tenancy', () => {
  it('refuses to work without a client key', async () => {
    const store = new ReactorConversationMessageService(liveDataSource());
    await expect(store.setSystemMessageContent('c'.repeat(24), 'x')).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('follows a client key given as a function, read on every call', () => {
    let key = 'tenant-a';
    const store: any = new ReactorConversationMessageService(liveDataSource(), { clientKey: () => key });
    expect(store.clientKey).toBe('tenant-a');
    key = 'tenant-b';
    expect(store.clientKey).toBe('tenant-b');
  });

  it('appends the tenant condition to raw SQL, before ORDER BY / LIMIT', () => {
    const store: any = new ReactorConversationMessageService(liveDataSource(), { clientKey: 'tenant-a' });
    const [sql, params] = store.scopedSql('SELECT id FROM t WHERE conversation_id = $1', ['conv'], 'ORDER BY seq LIMIT 1');
    expect(sql).toMatch(/WHERE conversation_id = \$1 AND client_key = \$2 ORDER BY seq LIMIT 1/);
    expect(params).toEqual(['conv', 'tenant-a']);
  });

  it('leaves raw SQL unfiltered only for an explicitly unscoped ops store', () => {
    const store: any = new ReactorConversationMessageService(liveDataSource(), { unscoped: true });
    const [sql, params] = store.scopedSql('SELECT 1 FROM t WHERE a = $1', [1]);
    expect(sql).not.toMatch(/client_key/);
    expect(params).toEqual([1]);
  });

  it('refuses a transaction on a conversation that holds another tenant rows', async () => {
    const store: any = new ReactorConversationMessageService(liveDataSource(), { clientKey: 'tenant-a' });
    const manager = { query: jest.fn(async () => [{ '?column?': 1 }]) };
    await expect(store.assertConversationTenant(manager, 'conv')).rejects.toThrow(/another client/);
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('client_key <> $2'), ['conv', 'tenant-a']);

    const clean = { query: jest.fn(async () => []) };
    await expect(store.assertConversationTenant(clean, 'conv')).resolves.toBeUndefined();
  });

  it('stamps the client key on every row it builds', () => {
    const store: any = new ReactorConversationMessageService(liveDataSource(), { clientKey: 'tenant-a' });
    const row = store.toRow('conv', { role: 'user', content: 'hi' }, 1);
    expect(row.clientKey).toBe('tenant-a');
  });
});

describe('ReactorUsageAnalyticsService tenancy', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Analytics = require('../ReactorUsageAnalyticsService').default ?? require('../ReactorUsageAnalyticsService').ReactorUsageAnalyticsService;

  afterEach(() => jest.restoreAllMocks());

  it('filters usage and failure queries on the request client', () => {
    const service: any = new Analytics({}, { partner: { key: 'tenant-a' } });
    const usage = service.buildWhere({ userId: 'u1' });
    expect(usage.clause).toMatch(/^m\.client_key = \$1 AND /);
    expect(usage.params[0]).toBe('tenant-a');
    expect(usage.clause).toMatch(/m\.user_id = \$2/);

    const failures = service.buildFailureWhere({});
    expect(failures.clause).toBe('f.client_key = $1');
    expect(failures.params).toEqual(['tenant-a']);
  });

  it('reports usage by message time, not by when the row was written', async () => {
    // The Mongo backfill wrote three months of messages with one created_at.
    const service: any = new Analytics({}, { partner: { key: 'tenant-a' }, log: jest.fn() });
    const usage = service.buildWhere({ startDate: '2026-08-25', endDate: '2026-09-24' });
    expect(usage.clause).toMatch(/m\.message_ts >= \$\d+ AND m\.message_ts < \$\d+/);
    expect(usage.clause).not.toMatch(/created_at/);

    const query = jest.fn(async () => [] as any[]);
    Object.defineProperty(service, 'dataSource', { get: () => ({ isInitialized: true, query }) });
    await service.getUsageSummary({});
    const series = (query.mock.calls as any[]).map(([sql]) => sql).find((sql: string) => /AS date/.test(sql) && /\bm\./.test(sql));
    expect(series).toMatch(/date_trunc\('day', m\.message_ts\)/);

    // Failures are recorded as they happen, so their created_at is the event time.
    expect(service.buildFailureWhere({ startDate: '2026-08-25' }).clause).toMatch(/f\.created_at >= /);
  });

  it('builds and runs every summary query, each scoped to the request client', async () => {
    // getUsageSummary referenced an undeclared `comps` and had never run: the
    // resolver failed first, then this threw a ReferenceError.
    const service: any = new Analytics({}, { partner: { key: 'tenant-a' }, log: jest.fn() });
    const query = jest.fn(async () => [] as any[]);
    Object.defineProperty(service, 'dataSource', { get: () => ({ isInitialized: true, query }) });

    await service.getUsageSummary({ startDate: '2026-08-25', endDate: '2026-09-24' });

    expect(query).toHaveBeenCalled();
    for (const [sql, params] of query.mock.calls as any[]) {
      expect(sql).toMatch(/client_key = \$1/);
      expect(params[0]).toBe('tenant-a');
    }
  });

  it('refuses analytics without a partner, and records no failure', async () => {
    const service: any = new Analytics({}, { log: jest.fn() });
    expect(() => service.buildWhere({})).toThrow(TenantScopeError);
    Object.defineProperty(service, 'dataSource', { get: () => ({ query: jest.fn() }) });
    await expect(service.recordFailure({ errorCode: 'x' })).resolves.toBe(false);
  });
});
