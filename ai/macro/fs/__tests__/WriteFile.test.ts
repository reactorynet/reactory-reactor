import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { WriteFile } from '../WriteFile/WriteFile';
import { MacroErrorCode } from '../../errors';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock `execFile` so we control what `lsof` reports in the open-handle guard.
// The macro does `promisify(execFile)` at module load — a plain jest.fn() has no
// util.promisify.custom symbol, so promisify falls back to default callback
// semantics: the last callback argument receives (err, value), where `value` is
// the resolved promise value. We simulate `{ stdout, stderr }` for success and an
// Error with `.code === 1` for the common "no results" case.
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

/** Configure the mocked lsof to report that no process holds the file open. */
function mockNoOpenHandles() {
  execFileMock.mockImplementation((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
    const err: NodeJS.ErrnoException = new Error('no results');
    err.code = 1 as unknown as string; // lsof exits 1 when nothing matches
    cb(err);
  });
}

/** Configure the mocked lsof to report the given PIDs as holding the file open. */
function mockOpenHandles(pids: string[]) {
  execFileMock.mockImplementation((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
    cb(null, { stdout: pids.join('\n') + '\n', stderr: '' });
  });
}

/** Configure the mocked lsof to fail with an unexpected error (e.g. binary missing). */
function mockLsofUnavailable() {
  execFileMock.mockImplementation((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
    const err: NodeJS.ErrnoException = new Error('command not found');
    err.code = 'ENOENT';
    cb(err);
  });
}

// ── State helper ───────────────────────────────────────────────────────────

function createMockState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    id: 'test-session',
    host: 'server',
    personaId: 'test-persona',
    persona: { id: 'test-persona', name: 'Test' } as any,
    started: new Date(),
    apiKey: 'k',
    apiOrg: 'o',
    modelId: 'gpt-4',
    history: [] as any,
    ai: {} as any,
    user: { id: 'user-test' },
    macros: [],
    tools: [],
    vars: {},
    ...overrides,
  } as ChatState;
}

// ── Filesystem fixtures ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'writefile-test-'));
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  execFileMock.mockReset();
  mockNoOpenHandles();
});

function uniquePath(name: string): string {
  // Each test gets a fresh filename so we don't leak state across cases.
  return path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
}

async function seedFile(name: string, content: string): Promise<string> {
  const filePath = uniquePath(name);
  await fsp.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readFile(filePath: string): Promise<string> {
  return (await fsp.readFile(filePath, 'utf-8')).toString();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WriteFile', () => {
  const state = createMockState();

  // ── 1. Validation ──────────────────────────────────────────────────────
  describe('validation', () => {
    it('rejects empty path with VALIDATION_REQUIRED_PARAM', async () => {
      const result = await WriteFile({ path: '', content: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_REQUIRED_PARAM);
      expect(result.error).toMatch(/path/i);
    });

    it('rejects empty content with VALIDATION_REQUIRED_PARAM', async () => {
      const result = await WriteFile({ path: '/tmp/whatever', content: '' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_REQUIRED_PARAM);
      expect(result.error).toMatch(/content/i);
    });

    it('rejects create mode when file already exists', async () => {
      const filePath = await seedFile('create-exists.txt', 'existing');
      const result = await WriteFile({ path: filePath, content: 'new', mode: 'create' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
      // Original content must be untouched.
      expect(await readFile(filePath)).toBe('existing');
    });

    it('rejects insert mode when end < start', async () => {
      const filePath = await seedFile('insert-bad-range.txt', 'a\nb\nc\n');
      const result = await WriteFile(
        { path: filePath, content: 'X', mode: 'insert', start: 3, end: 1 },
        state,
      );
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
    });
  });

  // ── 2. Happy-path writes ───────────────────────────────────────────────
  describe('write modes', () => {
    it('creates a new file with exact bytes including trailing newline', async () => {
      const filePath = uniquePath('create-new.txt');
      const payload = 'hello world\n';

      const result = await WriteFile({ path: filePath, content: payload, mode: 'create' }, state);

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(await readFile(filePath)).toBe(payload);
    });

    it('overwrite mode replaces existing content verbatim', async () => {
      const filePath = await seedFile('overwrite.txt', 'OLD CONTENT');
      const payload = 'completely new payload';

      const result = await WriteFile(
        { path: filePath, content: payload, mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe(payload);
    });

    it('overwrite preserves trailing whitespace and newlines (the verbatim guard)', async () => {
      // This is the regression guard: the previous implementation applied .trim()
      // on the final write, which silently dropped trailing whitespace and made
      // "new" content identical to existing on disk.
      const filePath = await seedFile('verbatim.txt', 'original');
      const payload = 'line with trailing spaces   \nand a blank line after\n\n';

      const result = await WriteFile(
        { path: filePath, content: payload, mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe(payload);
    });

    it('append joins existing content with the new payload via \\n', async () => {
      const filePath = await seedFile('append.txt', 'first line');
      const result = await WriteFile(
        { path: filePath, content: 'second line', mode: 'append' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('first line\nsecond line');
    });

    it('prepend joins the new payload with existing content via \\n', async () => {
      const filePath = await seedFile('prepend.txt', 'original content');
      const result = await WriteFile(
        { path: filePath, content: 'header', mode: 'prepend' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('header\noriginal content');
    });

    it('insert replaces the line range [start, end] with the payload', async () => {
      const filePath = await seedFile('insert.txt', 'a\nb\nc\nd\ne');
      const result = await WriteFile(
        { path: filePath, content: 'X\nY', mode: 'insert', start: 2, end: 3 },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('a\nX\nY\nd\ne');
    });
  });

  // ── 3. Code-block extraction ───────────────────────────────────────────
  describe('code-block extraction', () => {
    it('unwraps when the entire payload is a single complete fenced block', async () => {
      // Backward-compatible convenience: the AI wraps its whole answer in ```.
      const filePath = uniquePath('fenced.txt');
      const payload = '```ts\nconst x = 1;\n```';

      const result = await WriteFile({ path: filePath, content: payload, mode: 'create' }, state);

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('const x = 1;');
    });

    it('unwraps when the single fence is surrounded only by whitespace', async () => {
      const filePath = uniquePath('fenced-padded.txt');
      const payload = '\n\n```ts\nconst x = 1;\n```\n\n';

      const result = await WriteFile({ path: filePath, content: payload, mode: 'create' }, state);

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('const x = 1;');
    });

    // Regression: a markdown document that *embeds* a fenced code block used to
    // have the fence extracted, silently dropping everything outside. Now we
    // only unwrap complete single-fence payloads; anything else is written verbatim.
    it('does NOT strip fenced blocks embedded inside a larger document', async () => {
      const filePath = uniquePath('embedded-fence.md');
      const payload = [
        '# Title',
        '',
        'Intro paragraph.',
        '',
        '```text',
        'folder/',
        '└── file.ts',
        '```',
        '',
        '## Next section',
        'More prose here.',
      ].join('\n');

      const result = await WriteFile({ path: filePath, content: payload, mode: 'create' }, state);

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe(payload);
    });

    it('does NOT strip when the payload has multiple fenced blocks even if it starts and ends with a fence', async () => {
      const filePath = uniquePath('multi-fences.md');
      const payload = '```js\nA\n```\nfiller text\n```js\nB\n```';

      const result = await WriteFile({ path: filePath, content: payload, mode: 'create' }, state);

      expect(result.success).toBe(true);
      // Written verbatim — we don't try to guess which block the caller meant.
      expect(await readFile(filePath)).toBe(payload);
    });
  });

  // ── 4. Open-handle detection ───────────────────────────────────────────
  describe('open-handle detection', () => {
    it('blocks overwrite when a foreign PID holds the file open', async () => {
      const filePath = await seedFile('held-overwrite.txt', 'ORIGINAL');
      mockOpenHandles(['99999']); // a PID that is not ours

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_PERMISSION_DENIED);
      expect(result.error).toMatch(/99999/);
      // File content must be unchanged.
      expect(await readFile(filePath)).toBe('ORIGINAL');
    });

    it('ignores our own PID when scanning open handles', async () => {
      const filePath = await seedFile('self-handle.txt', 'ORIGINAL');
      mockOpenHandles([String(process.pid)]);

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('NEW');
    });

    it('proceeds when lsof reports no open handles', async () => {
      const filePath = await seedFile('no-handles.txt', 'ORIGINAL');
      mockNoOpenHandles();

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('NEW');
    });

    it('proceeds (best-effort) when lsof itself fails unexpectedly', async () => {
      const filePath = await seedFile('lsof-missing.txt', 'ORIGINAL');
      mockLsofUnavailable();

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('NEW');
    });

    it('does not consult lsof when creating a new (non-existent) file', async () => {
      const filePath = uniquePath('new-file.txt');
      mockOpenHandles(['99999']); // would block if consulted

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'create' },
        state,
      );

      expect(result.success).toBe(true);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(await readFile(filePath)).toBe('NEW');
    });

    it('also blocks append when a foreign PID holds the file open', async () => {
      const filePath = await seedFile('held-append.txt', 'ORIGINAL');
      mockOpenHandles(['88888']);

      const result = await WriteFile(
        { path: filePath, content: 'MORE', mode: 'append' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_PERMISSION_DENIED);
      expect(await readFile(filePath)).toBe('ORIGINAL');
    });
  });

  // ── 5. Post-write verification ─────────────────────────────────────────
  describe('post-write verification', () => {
    it('returns IO_READ_WRITE_ERROR when the on-disk content differs from the intended content', async () => {
      const filePath = await seedFile('verify-mismatch.txt', 'ORIGINAL');

      // Simulate a concurrent modifier: the write succeeds, but the verification
      // read sees different bytes. Only the verification read is intercepted —
      // overwrite mode reads the file exactly once (after writing).
      const readSpy = jest
        .spyOn(fsp, 'readFile')
        .mockImplementationOnce(async () => 'TAMPERED-LONGER' as any);

      const result = await WriteFile(
        { path: filePath, content: 'INTENDED', mode: 'overwrite' },
        state,
      );

      readSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_READ_WRITE_ERROR);
      expect(result.error).toMatch(/verification failed/i);
      expect(result.error).toMatch(/expected 8 bytes/); // "INTENDED".length
      expect(result.error).toMatch(/got 15 bytes/); // "TAMPERED-LONGER".length
    });

    it('succeeds when the on-disk content matches exactly', async () => {
      const filePath = await seedFile('verify-match.txt', 'ORIGINAL');
      const payload = 'EXACT\nBYTES\n';

      const result = await WriteFile(
        { path: filePath, content: payload, mode: 'overwrite' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.data?.size).toBe(Buffer.byteLength(payload, 'utf-8'));
      expect(await readFile(filePath)).toBe(payload);
    });
  });

  // ── 6. Filesystem error mapping ────────────────────────────────────────
  describe('filesystem error mapping', () => {
    it('maps ENOENT (missing parent directory) to IO_NOT_FOUND', async () => {
      const filePath = path.join(tmpDir, 'nonexistent-subdir', 'file.txt');

      const result = await WriteFile(
        { path: filePath, content: 'x', mode: 'create' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_NOT_FOUND);
    });

    it('maps EACCES on write to IO_PERMISSION_DENIED', async () => {
      const filePath = await seedFile('perm-denied.txt', 'ORIGINAL');

      const writeSpy = jest.spyOn(fsp, 'writeFile').mockImplementationOnce(async () => {
        const err: NodeJS.ErrnoException = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      });

      const result = await WriteFile(
        { path: filePath, content: 'NEW', mode: 'overwrite' },
        state,
      );

      writeSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_PERMISSION_DENIED);
      expect(existsSync(filePath)).toBe(true); // file still exists (not unlinked pre-write)
      expect(await readFile(filePath)).toBe('ORIGINAL');
    });
  });
});
