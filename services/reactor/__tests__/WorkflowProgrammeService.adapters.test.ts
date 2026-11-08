import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * Adapter-level tests for the two functions in `WorkflowProgrammeService` that
 * decide the outcomes the reconciler acts on:
 *
 *   * `findChildByDispatchId` — decides "does this dispatch already have a child?".
 *     A wrong answer here starts a DUPLICATE child, which is the exact failure the
 *     feature exists to remove. The service suite stubs it; this file runs it.
 *   * `ghVerifier` — decides "did this package succeed or fail?". It parses `gh`
 *     JSON and maps state; the service suite replaces it wholesale.
 *
 * Neither needs a live engine or a live GitHub: the workflow service and the `gh`
 * runner are injected, but everything between the injection point and the return
 * value is the real code.
 */

const mockTaskSave = jest.fn(async function (this: any) {
  return this;
});

jest.mock('@reactory/server-modules/reactory-core/models/Task', () => {
  const Model: any = function (this: any, doc: any) {
    Object.assign(this, doc, { _id: new ObjectId() });
  };
  Model.prototype.save = mockTaskSave;
  return { __esModule: true, default: Model };
});

import WorkflowProgrammeService, {
  DEFAULT_CHILD_WORKFLOW_ID,
  GH_TIMEOUT_MS,
  WORKFLOW_SERVICE_ID,
} from '../WorkflowProgrammeService';

const ownerId = new ObjectId();

let service: WorkflowProgrammeService;
let workflowService: any;

const programme = (overrides: Record<string, any> = {}): any => ({
  programmeId: 'p1',
  name: 'P1',
  state: 'active',
  ownerUserId: String(ownerId),
  ownerEmail: 'owner@example.com',
  childWorkflowId: DEFAULT_CHILD_WORKFLOW_ID,
  slaMinutes: 45,
  maxAttempts: 3,
  packages: [],
  ...overrides,
});

beforeEach(() => {
  workflowService = {
    startWorkflow: jest.fn(),
    cancelWorkflowInstance: jest.fn(),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
  };
  service = Object.create(WorkflowProgrammeService.prototype);
  service.context = {
    user: { _id: ownerId, email: 'owner@example.com', roles: ['USER'] },
    partner: { key: 'tenant-a' },
    log: jest.fn(),
    hasRole: () => false,
    getService: (id: string) => (id === WORKFLOW_SERVICE_ID ? workflowService : null),
  } as any;
  mockTaskSave.mockClear();
});

// ── findChildByDispatchId ───────────────────────────────────────────────────

describe('findChildByDispatchId', () => {
  it('matches on the dispatch id threaded into the child input, not on position or recency', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({
      instances: [
        { id: 'instance-newer', data: { inputs: { dispatchId: 'someone-else' } } },
        { id: 'instance-mine', data: { inputs: { dispatchId: 'dispatch-1' } } },
        { id: 'instance-older', data: { inputs: {} } },
      ],
    });

    const found: any = await service.findChildByDispatchId('dispatch-1', programme());

    expect(found?.id).toBe('instance-mine');
    const [filter, pagination] = workflowService.getWorkflowHistory.mock.calls[0] as any[];
    expect(filter).toEqual({ workflowDefinitionId: DEFAULT_CHILD_WORKFLOW_ID });
    // Newest first, so the most recent attempt is found if several ever exist.
    expect(pagination).toMatchObject({ page: 1, limit: 200, sortOrder: 'desc' });
  });

  it('searches the PACKAGE child workflow id when dispatch used an override', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({ instances: [] });

    await service.findChildByDispatchId('dispatch-1', programme(), {
      childWorkflowId: 'core.SpecialPackage@2.0.0',
    });

    // Searching the programme default would never find this child, so recovery
    // would re-arm and start a second one.
    expect((workflowService.getWorkflowHistory.mock.calls[0] as any[])[0]).toEqual({
      workflowDefinitionId: 'core.SpecialPackage@2.0.0',
    });
  });

  it('falls back to the module default when neither level names a workflow', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({ instances: [] });
    await service.findChildByDispatchId('dispatch-1', programme({ childWorkflowId: undefined }));
    expect((workflowService.getWorkflowHistory.mock.calls[0] as any[])[0]).toEqual({
      workflowDefinitionId: DEFAULT_CHILD_WORKFLOW_ID,
    });
  });

  it('returns undefined when no instance carries the dispatch id', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({ instances: [{ id: 'x', data: {} }] });
    expect(await service.findChildByDispatchId('missing', programme())).toBeUndefined();
  });

  it('returns undefined when the page has no instances at all', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({});
    expect(await service.findChildByDispatchId('dispatch-1', programme())).toBeUndefined();
  });

  it('returns undefined when the workflow service is unavailable', async () => {
    service.context = { ...(service.context as any), getService: (): null => null } as any;
    expect(await service.findChildByDispatchId('dispatch-1', programme())).toBeUndefined();
  });

  it('lets a history failure propagate, so the tick can isolate that programme', async () => {
    workflowService.getWorkflowHistory.mockRejectedValue(new Error('workflow history unavailable'));
    await expect(service.findChildByDispatchId('dispatch-1', programme())).rejects.toThrow(
      'workflow history unavailable',
    );
  });
});

// ── ghVerifier ──────────────────────────────────────────────────────────────

describe('ghVerifier', () => {
  const prUrl = 'https://github.com/reactorynet/reactory-reactor/pull/9';
  const pkg = (overrides: Record<string, any> = {}): any => ({ id: 'pkg-1', prUrl, ...overrides }) as any;

  it('skips (no external call) when the package has no pull request', async () => {
    const exec = jest.fn();
    service.ghExec = exec as any;

    const verdict = await service.ghVerifier(pkg({ prUrl: undefined }), programme());

    expect(verdict).toEqual({ kind: 'skipped' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a non-http prUrl without invoking gh', async () => {
    const exec = jest.fn();
    service.ghExec = exec as any;

    const verdict = await service.ghVerifier(pkg({ prUrl: '--help' }), programme());

    expect(verdict.kind).toBe('error');
    expect(exec).not.toHaveBeenCalled();
  });

  it('maps MERGED with a merge commit to a merged verdict carrying the SHA', async () => {
    const exec = jest.fn(async () => ({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergeCommit: { oid: 'sha-merged' },
        url: prUrl,
      }),
    }));
    service.ghExec = exec as any;

    const verdict = await service.ghVerifier(pkg(), programme());

    expect(verdict).toEqual({ kind: 'merged', mergedSha: 'sha-merged', prUrl });
    const [file, args, options] = exec.mock.calls[0] as any[];
    expect(file).toBe('gh');
    // The URL is ONE argv entry: execFile never involves a shell.
    expect(args).toEqual(['pr', 'view', prUrl, '--json', 'state,mergeCommit,mergedAt,url,number']);
    expect(options).toEqual({ timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  });

  it('maps MERGED without a merge commit (or a URL) to a merged verdict with no SHA', async () => {
    service.ghExec = jest.fn(async () => ({
      stdout: JSON.stringify({ state: 'MERGED' }),
    })) as any;

    const verdict = await service.ghVerifier(pkg(), programme());

    expect(verdict).toEqual({ kind: 'merged', mergedSha: undefined, prUrl });
  });

  it('maps CLOSED to a closed verdict', async () => {
    service.ghExec = jest.fn(async () => ({
      stdout: JSON.stringify({ state: 'CLOSED', url: prUrl }),
    })) as any;

    expect(await service.ghVerifier(pkg(), programme())).toEqual({ kind: 'closed', prUrl });
  });

  it('maps OPEN (and any unknown state) to open — evidence of life, not success', async () => {
    service.ghExec = jest.fn(async () => ({ stdout: JSON.stringify({ state: 'OPEN' }) })) as any;
    expect(await service.ghVerifier(pkg(), programme())).toEqual({ kind: 'open', prUrl });

    service.ghExec = jest.fn(async () => ({ stdout: JSON.stringify({ state: 'DRAFT' }) })) as any;
    expect((await service.ghVerifier(pkg(), programme())).kind).toBe('open');

    service.ghExec = jest.fn(async () => ({ stdout: '' })) as any;
    expect((await service.ghVerifier(pkg(), programme())).kind).toBe('open');
  });

  it('reports a non-zero exit as an error instead of inventing a verdict', async () => {
    service.ghExec = jest.fn(async () => {
      throw new Error('Command failed: gh pr view — rate limited');
    }) as any;

    const verdict = await service.ghVerifier(pkg(), programme());

    expect(verdict.kind).toBe('error');
    expect((verdict as any).error).toContain('rate limited');
  });

  it('reports unparseable output as an error', async () => {
    service.ghExec = jest.fn(async () => ({ stdout: 'not json' })) as any;
    expect((await service.ghVerifier(pkg(), programme())).kind).toBe('error');
  });
});
