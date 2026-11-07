import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * End-to-end test for the worktree test wrapper's EXIT-CODE CONTRACT.
 *
 * This is the test that was missing: the first iteration of this harness passed its unit tests
 * while the documented baseline command reported 55 suites / 756 tests passed and exited 1, so an
 * engineer following the recipe would have called a green run failed. An automated assertion that a
 * known-green run exits 0 - and that a deliberately broken run exits 1 - is the only thing that
 * stops that regressing silently.
 *
 * Covered:
 *   - GREEN  : a known-green suite exits 0 and the summary reports the expected counts.
 *   - RED    : a failing assertion exits 1 (--forceExit must never mask a real failure).
 *   - RED    : a suite that cannot LOAD exits 1 (the original defect class: "Tests: 0 total").
 *
 * The wrapper is spawned as a real child process because the contract is about `process.exitCode`,
 * which cannot be observed in-process.
 */

const WRAPPER = path.resolve(__dirname, '..', 'run-worktree-tests.js');
const MODULE_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(MODULE_ROOT, '.ai-agent', 'e2e-run-worktree-tests');

interface RunResult {
  status: number | null;
  output: string;
}

function runWrapper(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: MODULE_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });

  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeFixture(name: string, source: string): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * Recursively delete a directory. `fs.rmSync` is not declared by every @types/node this repo has
 * shipped against, so resolve it dynamically rather than depending on the typing.
 */
function removeDirectory(dir: string): void {
  const fsAny = fs as unknown as Record<string, unknown>;
  try {
    const rmSync = fsAny.rmSync as ((target: string, options: object) => void) | undefined;
    if (typeof rmSync === 'function') {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const rmdirSync = fsAny.rmdirSync as ((target: string, options: object) => void) | undefined;
    if (typeof rmdirSync === 'function') rmdirSync(dir, { recursive: true });
  } catch (error) {
    /* best effort */
  }
}

/** Remove the fixtures before AND after, so a crashed run cannot poison a later full-module run. */
function cleanFixtures(): void {
  removeDirectory(FIXTURE_DIR);
}
beforeAll(() => {
  cleanFixtures();
});

afterAll(() => {
  cleanFixtures();
});

describe('run-worktree-tests wrapper - exit-code contract', () => {
  it('exits 0 and reports real counts for a known-green suite', () => {
    const { status, output } = runWrapper([
      'services/reactor/__tests__/ReactorConversationService.contextLength.test.ts',
    ]);

    // The assertion a false red would have failed: a green run MUST exit 0.
    expect(status).toBe(0);
    expect(output).toContain('Test Suites: 1 passed, 1 total');
    expect(output).toContain('Tests:       5 passed, 5 total');
    expect(output).toContain('exit code 0 (every collected test passed)');
    // The wrapper must say which config and which mount offset it used.
    expect(output).toContain('[run-worktree-tests] layout');
  }, 240000);

  it('exits 1 when an assertion fails, even though --forceExit is applied by default', () => {
    const fixture = writeFixture(
      'failing-assertion.test.ts',
      [
        "import { describe, it, expect } from '@jest/globals';",
        '',
        "describe('wrapper e2e - deliberate failure', () => {",
        "  it('fails on purpose', () => {",
        '    expect(2 + 2).toBe(5);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    const { status, output } = runWrapper([fixture]);

    expect(status).toBe(1);
    expect(output).toContain('1 failed');
    expect(output).toContain('exit code 1');
  }, 240000);

  it('exits 1 when a suite cannot load, and never reports it as a pass', () => {
    const fixture = writeFixture(
      'load-error.test.ts',
      [
        "import { describe, it, expect } from '@jest/globals';",
        "import '../../../database/tenant/ClientKeyColumn';",
        '',
        '// The specifier above is deliberately short by one level, exactly like the defect this',
        '// harness exists to fix. It must fail to load and must NOT be reported as a pass.',
        "describe('wrapper e2e - load failure', () => {",
        "  it('never runs', () => {",
        '    expect(true).toBe(true);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    const { status, output } = runWrapper([fixture]);

    expect(status).toBe(1);
    expect(output).toContain('Test suite failed to run');
    expect(output).toContain('exit code 1');
  }, 240000);
});
