import { describe, it, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parse, Kind, ObjectTypeDefinitionNode } from 'graphql';

/**
 * `ReactorPendingContinuations` — the checkable half of an agent's promise.
 *
 * The ticket's acceptance criterion is unusually precise: the query must return
 * only the caller's records and must NEVER expose `correlationKey`. Both halves
 * are asserted here, and neither assertion is allowed to pass by accident:
 *
 *   - the **schema** is parsed and its field list compared exactly, so adding a
 *     field is a deliberate act that fails this test until it is reviewed;
 *   - the **serialised result** is checked by stringifying what the resolver
 *     returns, not by inspecting the service mock. A widened service projection
 *     (the realistic regression: someone adds a field to `toPublicView`) would
 *     still have to survive the resolver's explicit re-projection;
 *   - **ownership** is asserted on the argument the resolver hands the service,
 *     because that is the one place a tenant scope can be lost. The service's own
 *     refusal is covered in `AgentContinuationService.test.ts`; here we prove the
 *     resolver neither invents a `userId` nor swallows a refusal into `[]`.
 */

import ReactorContinuationResolver, {
  toPendingContinuationShape,
} from '../ReactorContinuation';
import {
  CONTINUATION_SERVICE_ID as SERVICE_ID,
} from '../../../ai/macro/runtime/continuationProjection';

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'ReactorContinuation.graphql');
const SCHEMA_SOURCE = fs.readFileSync(SCHEMA_PATH, 'utf8');

/** The exact wire contract. Order-insensitive comparison, but closed. */
const EXPECTED_FIELDS = [
  'continuationId',
  'reason',
  'state',
  'fireAt',
  'firedAt',
  'outcome',
  'chatSessionId',
  'personaId',
  'createdAt',
];

const OWNER_ID = '651f1a2b3c4d5e6f708192a3';
const OTHER_ID = '651f1a2b3c4d5e6f708192b4';
const SESSION_ID = '507f1f77bcf86cd799439011';

/**
 * The SERVICE_ID used by the resolver is defined in the resolver itself; this
 * constant is imported from the projection purely so a future rename of the FQN
 * breaks compilation in one place instead of silently pointing at nothing.
 */
const RESOLVER_SERVICE_ID = 'reactor.AgentContinuationService@1.0.0';

const publicView = (overrides: Record<string, any> = {}) => ({
  continuationId: '6f3a1b2c-0000-4000-8000-000000000001',
  chatSessionId: SESSION_ID,
  personaId: 'ReactorAIPersona',
  reason: 'PR 482 merge',
  triggerKind: 'at',
  triggerSummary: 'at 2026-10-23T14:00:00.000Z',
  state: 'armed',
  fireAt: '2026-10-23T14:00:00.000Z',
  firedAt: undefined,
  firedBy: undefined,
  outcome: undefined,
  attempt: 0,
  maxAttempts: 5,
  lastError: undefined,
  workflowInstanceId: 'wf-1',
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
  ...overrides,
});

const makeContext = (service: any, user: any = { _id: OWNER_ID }) =>
  ({
    user,
    getService: jest.fn((id: string) => (id === SERVICE_ID ? service : null)),
  }) as any;

/**
 * The decorator stores the query on the prototype's `resolver` map and binds it
 * lazily. Calling through that map is deliberate: it is the same path the GraphQL
 * root uses, so a resolver that only works when called directly would fail here.
 */
const query = (): any =>
  (ReactorContinuationResolver as any).prototype.resolver.Query.ReactorPendingContinuations;

describe('ReactorPendingContinuations — schema contract', () => {
  it('declares exactly the nine documented fields, and no credential', () => {
    const document = parse(SCHEMA_SOURCE);
    const type = document.definitions.find(
      (definition): definition is ObjectTypeDefinitionNode =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION &&
        definition.name.value === 'ReactorPendingContinuation',
    );

    expect(type).toBeDefined();
    const fields = (type!.fields || []).map((field) => field.name.value);

    // Closed set: an added field fails until EXPECTED_FIELDS is reviewed, which is
    // the point. `correlationKey` must never be in the list.
    expect([...fields].sort()).toEqual([...EXPECTED_FIELDS].sort());

    // Belt to the closed-set braces: a future edit that both adds the field and
    // updates EXPECTED_FIELDS still trips this line.
    expect(fields).not.toContain('correlationKey');
  });

  it('binds the query in Query with the observability arguments', () => {
    const document = parse(SCHEMA_SOURCE);
    // The module contributes to the shared root, so it is an `extend type Query`
    // (OBJECT_TYPE_EXTENSION), not the definition.
    const queryType = document.definitions.find(
      (definition): definition is ObjectTypeDefinitionNode =>
        (definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
          definition.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        definition.name.value === 'Query',
    );

    expect(queryType).toBeDefined();
    const field = (queryType!.fields || []).find(
      (candidate) => candidate.name.value === 'ReactorPendingContinuations',
    );

    expect(field).toBeDefined();
    expect(field!.arguments!.map((argument) => argument.name.value)).toEqual([
      'chatSessionId',
      'includeTerminal',
      'userId',
      'limit',
    ]);
  });
});

describe('ReactorPendingContinuations — the serialised result', () => {
  it('drops correlationKey even when the service leaks it', async () => {
    // The realistic regression: `toPublicView` gains a field. The resolver must not
    // forward it, so the mock deliberately returns the credential.
    const leaked = publicView({ correlationKey: 'a'.repeat(64) }) as any;
    const listForViewer = jest.fn(async () => [leaked]);

    const result = await query()({}, {}, makeContext({ listForViewer }));

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]).sort()).toEqual([...EXPECTED_FIELDS].sort());
    expect(result[0]).not.toHaveProperty('correlationKey');
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(result)).not.toMatch(/correlationKey/);
  });

  it('maps every field through, keeping nulls for absent terminal data', async () => {
    const listForViewer = jest.fn(async () => [
      publicView({ state: 'armed', firedAt: undefined, outcome: undefined }),
    ]);

    const result = await query()({}, {}, makeContext({ listForViewer }));

    expect(result[0]).toEqual({
      continuationId: '6f3a1b2c-0000-4000-8000-000000000001',
      reason: 'PR 482 merge',
      state: 'armed',
      fireAt: '2026-10-23T14:00:00.000Z',
      firedAt: null,
      outcome: null,
      chatSessionId: SESSION_ID,
      personaId: 'ReactorAIPersona',
      createdAt: '2026-10-23T10:00:00.000Z',
    });
  });

  it('shape helper never carries an unlisted field', () => {
    const shaped = toPendingContinuationShape(
      publicView({ correlationKey: 'secret', ownerEmail: 'a@b.c' }) as any,
    );

    expect(shaped).not.toHaveProperty('correlationKey');
    expect(shaped).not.toHaveProperty('ownerEmail');
    expect(Object.keys(shaped).sort()).toEqual([...EXPECTED_FIELDS].sort());
  });
});

describe('ReactorPendingContinuations — ownership', () => {
  it('scopes to the caller by passing no userId', async () => {
    const listForViewer = jest.fn(async () => [publicView()]);

    await query()({}, {}, makeContext({ listForViewer }));

    expect(listForViewer).toHaveBeenCalledWith({
      chatSessionId: undefined,
      includeTerminal: false,
      userId: undefined,
      limit: undefined,
    });
  });

  it('passes an explicit userId through so the service can decide', async () => {
    const listForViewer = jest.fn(async () => []);

    await query()(
      {},
      { userId: OTHER_ID, chatSessionId: SESSION_ID, includeTerminal: true, limit: 5 },
      makeContext({ listForViewer }),
    );

    expect(listForViewer).toHaveBeenCalledWith({
      chatSessionId: SESSION_ID,
      includeTerminal: true,
      userId: OTHER_ID,
      limit: 5,
    });
  });

  it('propagates the service refusal instead of returning an empty list', async () => {
    const listForViewer = jest.fn(async () => {
      throw new Error(
        "Access denied: listing another user's pending continuations requires an administrators role.",
      );
    });

    // An empty list would read as "you are waiting on nothing" — a silent lie.
    await expect(
      query()({}, { userId: OTHER_ID }, makeContext({ listForViewer })),
    ).rejects.toThrow(/requires an administrators role/);
  });

  it('fails loudly when the continuation service is unavailable', async () => {
    const context = { user: { _id: OWNER_ID }, getService: () => null } as any;

    await expect(query()({}, {}, context)).rejects.toThrow(
      new RegExp(`${RESOLVER_SERVICE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('returns [] (not undefined) when the service has no rows', async () => {
    const listForViewer = jest.fn(async () => undefined);

    await expect(query()({}, {}, makeContext({ listForViewer }))).resolves.toEqual([]);
  });
});

describe('ReactorPendingContinuations — service identity', () => {
  it('asks the registry for the FQN the module registers', () => {
    // The projection and the resolver must agree on the id, otherwise the todo
    // surface and the query would read different records and never be noticed.
    expect(RESOLVER_SERVICE_ID).toBe(SERVICE_ID);
  });
});
