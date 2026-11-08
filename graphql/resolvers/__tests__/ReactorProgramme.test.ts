import { describe, it, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parse, Kind, ObjectTypeDefinitionNode, ObjectTypeExtensionNode } from 'graphql';

/**
 * `ReactorProgramme` — read + control for the programme reconciler.
 *
 * The acceptance criteria this suite pins:
 *
 *  - six GraphQL operations exist (`programme`, `programmes`, `createProgramme`,
 *    `pauseProgramme`, `resumeProgramme`, `abortProgramme`);
 *  - each is a THIN delegation: the service is called with the caller's arguments
 *    and its answers are not re-interpreted;
 *  - pause/resume/abort refuse the SYSTEM identity *even when it holds ADMIN* — the
 *    refusal must happen before the service call, so a future change to the
 *    service's authorisation cannot silently re-open control to the reconciler;
 *  - the public shape cannot leak `childInputDefaults` or a package's `input`,
 *    which may carry workflow inputs.
 */

import ReactorProgrammeResolver, {
  PROGRAMME_SERVICE_ID as RESOLVER_SERVICE_ID,
  toControlResult,
  toProgrammeShape,
} from '../ReactorProgramme';
import { PROGRAMME_SERVICE_ID as MACRO_SERVICE_ID } from '../../../ai/macro/runtime/programmeMacro.macro';

const SCHEMA_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'schema', 'ReactorProgramme.graphql'),
  'utf8',
);

const OWNER_ID = '651f1a2b3c4d5e6f708192a3';
const PROGRAMME_ID = 'reactor-hardening-a1b2c3d4';

/** The service view `toProgrammeView` produces, plus two fields that must not escape. */
const programmeView = (overrides: Record<string, any> = {}): Record<string, any> => ({
  programmeId: PROGRAMME_ID,
  name: 'Reactor hardening',
  description: 'two packages',
  state: 'active',
  ownerEmail: 'owner@example.com',
  childWorkflowId: 'core.ProcessAITicket@1.4.7',
  slaMinutes: 45,
  maxAttempts: 3,
  counts: { ready: 1, pending: 1 },
  packages: [
    {
      id: 'pkg-1',
      title: 'first',
      dependsOn: [],
      state: 'ready',
      attempt: 0,
      dispatchId: 'd-1',
      childInstanceId: undefined,
      dispatchedAt: undefined,
      lastProgressAt: new Date('2026-11-08T10:00:00.000Z'),
      completedAt: undefined,
      prUrl: undefined,
      mergedSha: undefined,
      status: undefined,
      outcomeSource: undefined,
      lastError: undefined,
      // Not part of the read contract — may carry workflow inputs.
      input: { token: 'super-secret' },
    },
  ],
  createdAt: new Date('2026-11-08T09:00:00.000Z'),
  updatedAt: new Date('2026-11-08T10:00:00.000Z'),
  completedAt: undefined,
  pausedAt: undefined,
  abortedAt: undefined,
  notificationChannel: undefined,
  notifiedEvent: undefined,
  // Not part of the read contract at all.
  childInputDefaults: { token: 'super-secret' },
  ...overrides,
});

const makeContext = (service: any, user: any = { _id: OWNER_ID, email: 'owner@example.com' }) =>
  ({
    user,
    hasRole: (role: string) => (user?.roles || []).includes(role),
    getService: jest.fn((id: string) => (id === MACRO_SERVICE_ID ? service : null)),
  }) as any;

const resolverRoot = (): any => (ReactorProgrammeResolver as any).prototype.resolver;
const query = (name: string): any => resolverRoot().Query[name];
const mutation = (name: string): any => resolverRoot().Mutation[name];

// ── schema contract ──────────────────────────────────────────────────────────

describe('ReactorProgramme schema', () => {
  const document = parse(SCHEMA_SOURCE);

  const fieldsOf = (name: string): string[] => {
    const node = document.definitions.find(
      (definition): definition is ObjectTypeDefinitionNode =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === name,
    );
    expect(node).toBeDefined();
    return (node!.fields || []).map((field) => field.name.value);
  };

  const operationOf = (root: 'Query' | 'Mutation', name: string) => {
    const node = document.definitions.find(
      (definition): definition is ObjectTypeExtensionNode =>
        definition.kind === Kind.OBJECT_TYPE_EXTENSION && definition.name.value === root,
    );
    expect(node).toBeDefined();
    return (node!.fields || []).find((field) => field.name.value === name);
  };

  it('declares the six required operations', () => {
    expect(query('programme')).toBeDefined();
    expect(query('programmes')).toBeDefined();
    expect(mutation('createProgramme')).toBeDefined();
    expect(mutation('pauseProgramme')).toBeDefined();
    expect(mutation('resumeProgramme')).toBeDefined();
    expect(mutation('abortProgramme')).toBeDefined();
  });

  it('binds the documented arguments for each operation', () => {
    const argumentsOf = (root: 'Query' | 'Mutation', name: string) =>
      (operationOf(root, name)!.arguments || []).map((argument) => argument.name.value);

    expect(argumentsOf('Query', 'programme')).toEqual(['programmeId']);
    expect(argumentsOf('Query', 'programmes')).toEqual(['state', 'limit']);
    expect(argumentsOf('Mutation', 'createProgramme')).toEqual(['input']);
    expect(argumentsOf('Mutation', 'pauseProgramme')).toEqual(['programmeId', 'reason']);
    expect(argumentsOf('Mutation', 'resumeProgramme')).toEqual(['programmeId', 'reason']);
    expect(argumentsOf('Mutation', 'abortProgramme')).toEqual(['programmeId', 'reason']);
  });

  it('exposes a programme with its packages and counts, and no input defaults', () => {
    const fields = fieldsOf('ReactorWorkflowProgramme');

    expect(fields).toContain('programmeId');
    expect(fields).toContain('state');
    expect(fields).toContain('packages');
    expect(fields).toContain('counts');

    // The two fields that must never be on the OUTPUT type.
    expect(fields).not.toContain('childInputDefaults');
    expect(fields).not.toContain('input');
    // It exists only on the CREATE input, where it is how a caller supplies it.
    expect(SCHEMA_SOURCE).toMatch(/input ReactorCreateProgrammeInput[\s\S]*childInputDefaults: JSON/);
  });

  it('declares a package type with the reconciler vocabulary, and no package input', () => {
    const fields = fieldsOf('ReactorWorkflowProgrammePackage');

    expect(fields.sort()).toEqual(
      [
        'id',
        'title',
        'dependsOn',
        'state',
        'attempt',
        'dispatchId',
        'childInstanceId',
        'dispatchedAt',
        'lastProgressAt',
        'completedAt',
        'prUrl',
        'mergedSha',
        'status',
        'outcomeSource',
        'lastError',
      ].sort(),
    );
  });
});

// ── reads ────────────────────────────────────────────────────────────────────

describe('programme queries', () => {
  it('programme delegates to getProgramme and projects the view', async () => {
    const getProgramme = jest.fn(async () => ({ found: true, programme: programmeView() }));
    const result = await query('programme')({}, { programmeId: PROGRAMME_ID }, makeContext({ getProgramme }));

    expect(getProgramme).toHaveBeenCalledWith({ programmeId: PROGRAMME_ID });
    expect(result.programmeId).toBe(PROGRAMME_ID);
    expect(result.ownerEmail).toBe('owner@example.com');
    expect(result.createdAt).toBe('2026-11-08T09:00:00.000Z');
    expect(result.counts).toEqual([
      { state: 'ready', count: 1 },
      { state: 'pending', count: 1 },
    ]);
    expect(result.packages[0].lastProgressAt).toBe('2026-11-08T10:00:00.000Z');
    expect(result.packages[0].childInstanceId).toBeNull();
  });

  it('programme returns null for an unknown id (404-ish, not a raw throw)', async () => {
    const getProgramme = jest.fn(async () => ({
      found: false,
      code: 'not_found',
      error: 'No programme "nope".',
    }));

    await expect(
      query('programme')({}, { programmeId: 'nope' }, makeContext({ getProgramme })),
    ).resolves.toBeNull();
  });

  it('programme raises when the caller may not read it', async () => {
    const getProgramme = jest.fn(async () => ({
      found: false,
      code: 'not_authorised',
      error: 'This programme belongs to another user.',
    }));

    await expect(
      query('programme')({}, { programmeId: PROGRAMME_ID }, makeContext({ getProgramme })),
    ).rejects.toThrow(/belongs to another user/);
  });

  it('programmes delegates state + limit and returns an array', async () => {
    const listProgrammes = jest.fn(async () => ({
      programmes: [programmeView(), programmeView({ programmeId: 'p-2', state: 'paused' })],
      total: 2,
    }));

    const result = await query('programmes')(
      {},
      { state: 'active', limit: 5 },
      makeContext({ listProgrammes }),
    );

    expect(listProgrammes).toHaveBeenCalledWith({ state: 'active', limit: 5 });
    expect(result).toHaveLength(2);
    expect(result[1].state).toBe('paused');
  });

  it('programmes raises for an anonymous caller instead of returning []', async () => {
    const listProgrammes = jest.fn(async () => ({ programmes: [], total: 0, code: 'no_identity' }));

    await expect(
      query('programmes')({}, {}, makeContext({ listProgrammes })),
    ).rejects.toThrow(/Authentication required/);
  });

  it('fails loudly when the service is unavailable', async () => {
    const context = { user: { _id: OWNER_ID }, getService: (): any => null } as any;

    await expect(query('programme')({}, { programmeId: PROGRAMME_ID }, context)).rejects.toThrow(
      /reactor\.WorkflowProgrammeService@1\.0\.0 is not available/,
    );
  });

  it('never serialises childInputDefaults or a package input, even if the view leaks them', () => {
    const shaped = toProgrammeShape(programmeView());
    const serialised = JSON.stringify(shaped);

    expect(serialised).not.toContain('super-secret');
    expect(shaped).not.toHaveProperty('childInputDefaults');
    expect(shaped.packages[0]).not.toHaveProperty('input');
  });

  it('resolves the same service FQN the macro and the reconciler use', () => {
    expect(RESOLVER_SERVICE_ID).toBe(MACRO_SERVICE_ID);
    expect(RESOLVER_SERVICE_ID).toBe('reactor.WorkflowProgrammeService@1.0.0');
  });
});

// ── writes ───────────────────────────────────────────────────────────────────

describe('programme mutations', () => {
  const input = {
    name: 'Reactor hardening',
    childInputDefaults: { agentId: 'ReactorAIPersona' },
    packages: [{ id: 'pkg-1' }],
  };

  it('createProgramme delegates the input and returns the created programme', async () => {
    const createProgramme = jest.fn(async () => ({
      created: true,
      programme: programmeView({ name: 'Reactor hardening' }),
    }));

    const result = await mutation('createProgramme')(
      {},
      { input },
      makeContext({ createProgramme }),
    );

    expect(createProgramme).toHaveBeenCalledWith(input);
    expect(result.programmeId).toBe(PROGRAMME_ID);
  });

  it('createProgramme raises on a refusal and does not quote childInputDefaults', async () => {
    const createProgramme = jest.fn(async () => ({
      created: false,
      code: 'duplicate',
      error: 'A programme with id "reactor-hardening-a1b2c3d4" already exists.',
    }));

    const attempt = mutation('createProgramme')({}, { input }, makeContext({ createProgramme }));

    await expect(attempt).rejects.toThrow(/duplicate/);
    await expect(attempt).rejects.not.toThrow(/ReactorAIPersona/);
  });

  it.each(['pauseProgramme', 'resumeProgramme', 'abortProgramme'] as const)(
    '%s delegates programmeId + reason and shapes the result',
    async (name) => {
      const method = name.replace('Programme', '') as 'pause' | 'resume' | 'abort';
      // The service's own flag vocabulary: pause → `paused`, etc.
      const flag = method === 'pause' ? 'paused' : method === 'resume' ? 'resumed' : 'aborted';
      const serviceResult = {
        [flag]: true,
        state: method === 'pause' ? 'paused' : method === 'resume' ? 'active' : 'aborted',
        runningPackages: method === 'pause' ? 2 : undefined,
        cancelled: method === 'abort' ? 3 : undefined,
      };
      const service: any = { [method]: jest.fn(async () => serviceResult) };

      const result = await mutation(name)(
        {},
        { programmeId: PROGRAMME_ID, reason: 'operator asked' },
        makeContext(service),
      );

      expect(service[method]).toHaveBeenCalledWith({
        programmeId: PROGRAMME_ID,
        reason: 'operator asked',
      });
      expect(result.ok).toBe(true);
      expect(result.state).toBe(serviceResult.state);
    },
  );

  it('shapes a refusal as data (ok false + code), so a client can report why', () => {
    expect(
      toControlResult({
        paused: false,
        code: 'invalid_state',
        reason: 'Cannot pause a paused programme.',
      }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_state',
      reason: 'Cannot pause a paused programme.',
      paused: false,
      state: null,
    });
  });
});

// ── identity: the second gate ────────────────────────────────────────────────

describe('programme control refuses the system identity', () => {
  const previousEmail = process.env.SYSTEM_USER_EMAIL;
  const systemUser = {
    _id: '651f1a2b3c4d5e6f708192ff',
    email: 'system@reactory.net',
    // ADMIN is deliberately present: the role must not be able to stand in for a
    // person on the audit trail.
    roles: ['ADMIN', 'SUPERADMIN', 'DEVELOPER'],
  };

  beforeEach(() => {
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
  });

  afterEach(() => {
    if (previousEmail === undefined) delete process.env.SYSTEM_USER_EMAIL;
    else process.env.SYSTEM_USER_EMAIL = previousEmail;
  });

  it.each(['pauseProgramme', 'resumeProgramme', 'abortProgramme'] as const)(
    '%s refuses the system account even with ADMIN and never calls the service',
    async (name) => {
      const method = name.replace('Programme', '') as 'pause' | 'resume' | 'abort';
      const flag = method === 'pause' ? 'paused' : method === 'resume' ? 'resumed' : 'aborted';
      const service: any = { [method]: jest.fn(async () => ({ [flag]: true })) };

      await expect(
        mutation(name)({}, { programmeId: PROGRAMME_ID }, makeContext(service, systemUser)),
      ).rejects.toThrow(/system account cannot pause, resume or abort/);

      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it.each(['pauseProgramme', 'resumeProgramme', 'abortProgramme'] as const)(
    '%s requires a signed-in user',
    async (name) => {
      const service: any = { pause: jest.fn(), resume: jest.fn(), abort: jest.fn() };

      await expect(
        mutation(name)({}, { programmeId: PROGRAMME_ID }, makeContext(service, null)),
      ).rejects.toThrow(/Authentication required/);
    },
  );

  it('a NON-system ADMIN detail is not refused by the resolver (the service decides)', async () => {
    // The resolver's gate is "is this the system account", not "is this an admin".
    // Owner/admin authorisation stays in the service so there is one policy.
    const pause = jest.fn(async () => ({ paused: true, state: 'paused', runningPackages: 0 }));
    const admin = { _id: '651f1a2b3c4d5e6f708192aa', email: 'admin@example.com', roles: ['ADMIN'] };

    const result = await mutation('pauseProgramme')(
      {},
      { programmeId: PROGRAMME_ID },
      makeContext({ pause }, admin),
    );

    expect(pause).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
