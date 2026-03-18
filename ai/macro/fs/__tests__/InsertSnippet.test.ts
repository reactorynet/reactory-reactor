import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { InsertSnippet } from '../InsertSnippet/InsertSnippet';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

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

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insertsnippet-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readFile(filePath: string): Promise<string> {
  return (await fs.readFile(filePath, 'utf-8')).toString();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('InsertSnippet', () => {
  const state = createMockState();

  // ── Input validation ────────────────────────────────────────────────────
  describe('validation', () => {
    it('returns error when path is empty', async () => {
      const result = await InsertSnippet({ path: '', start: '1', snippet: 'x' }, state);
      expect(result).toMatch(/error.*path/i);
    });

    it('returns error when start is missing', async () => {
      const filePath = await writeFile('val-no-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '', snippet: 'x' }, state);
      expect(result).toMatch(/error.*start/i);
    });

    it('returns error when start is not a number', async () => {
      const filePath = await writeFile('val-nan-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: 'abc', snippet: 'x' }, state);
      expect(result).toMatch(/error.*start/i);
    });

    it('returns error when start is zero', async () => {
      const filePath = await writeFile('val-zero-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '0', snippet: 'x' }, state);
      expect(result).toMatch(/error.*start/i);
    });

    it('returns error when start exceeds file length', async () => {
      const filePath = await writeFile('val-oob-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '99', snippet: 'x' }, state);
      expect(result).toMatch(/error.*start.*beyond/i);
    });

    it('returns error when end is less than start', async () => {
      const filePath = await writeFile('val-end-lt-start.txt', 'a\nb\nc\n');
      const result = await InsertSnippet({ path: filePath, start: '3', end: '2', snippet: 'x' }, state);
      expect(result).toMatch(/error.*end/i);
    });

    it('returns error for non-existent file', async () => {
      const result = await InsertSnippet({
        path: path.join(tmpDir, 'no-such-file.txt'),
        start: '1',
        snippet: 'x',
      }, state);
      expect(result).toMatch(/error/i);
    });
  });

  // ── INSERT mode (no end given) ──────────────────────────────────────────
  describe('INSERT mode (no end)', () => {
    it('inserts snippet BEFORE the target line, preserving original content', async () => {
      // File with 5 lines; insert before line 3
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('insert-mid.txt', original);

      const result = await InsertSnippet({ path: filePath, start: '3', snippet: 'INSERTED' }, state);
      expect(result).toMatch(/successfully/i);

      const content = await readFile(filePath);
      const lines = content.split('\n');
      expect(lines).toEqual(['line1', 'line2', 'INSERTED', 'line3', 'line4', 'line5']);
    });

    it('inserts at line 1 (beginning of file)', async () => {
      const original = 'first\nsecond\nthird';
      const filePath = await writeFile('insert-first.txt', original);

      await InsertSnippet({ path: filePath, start: '1', snippet: 'BEFORE_FIRST' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['BEFORE_FIRST', 'first', 'second', 'third']);
    });

    it('inserts at last line', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('insert-last.txt', original);

      await InsertSnippet({ path: filePath, start: '3', snippet: 'BEFORE_LAST' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['a', 'b', 'BEFORE_LAST', 'c']);
    });

    it('inserts a multi-line snippet', async () => {
      const original = 'alpha\nbeta\ngamma';
      const filePath = await writeFile('insert-multiline.txt', original);

      await InsertSnippet({ path: filePath, start: '2', snippet: 'X\nY\nZ' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['alpha', 'X', 'Y', 'Z', 'beta', 'gamma']);
    });
  });

  // ── REPLACE mode (start and end given) ─────────────────────────────────
  describe('REPLACE mode (start and end given)', () => {
    it('replaces a single line when start === end', async () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('replace-single.txt', original);

      await InsertSnippet({ path: filePath, start: '3', end: '3', snippet: 'REPLACED' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'line2', 'REPLACED', 'line4', 'line5']);
    });

    it('replaces a range of lines', async () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('replace-range.txt', original);

      await InsertSnippet({ path: filePath, start: '2', end: '4', snippet: 'BLOCK' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'BLOCK', 'line5']);
    });

    it('replaces from start to end of file', async () => {
      const original = 'a\nb\nc\nd';
      const filePath = await writeFile('replace-to-eof.txt', original);

      await InsertSnippet({ path: filePath, start: '3', end: '4', snippet: 'TAIL' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['a', 'b', 'TAIL']);
    });

    it('replaces first line', async () => {
      const original = 'OLD_FIRST\nsecond\nthird';
      const filePath = await writeFile('replace-first.txt', original);

      await InsertSnippet({ path: filePath, start: '1', end: '1', snippet: 'NEW_FIRST' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['NEW_FIRST', 'second', 'third']);
    });
  });

  // ── CRLF line endings ───────────────────────────────────────────────────
  describe('CRLF line ending preservation', () => {
    it('preserves CRLF endings after insert', async () => {
      const original = 'line1\r\nline2\r\nline3\r\nline4';
      const filePath = await writeFile('crlf-insert.txt', original);

      await InsertSnippet({ path: filePath, start: '2', snippet: 'INSERTED' }, state);

      const raw = await readFile(filePath);
      // All joins should use CRLF
      expect(raw).toBe('line1\r\nINSERTED\r\nline2\r\nline3\r\nline4');
    });

    it('preserves CRLF endings after replace', async () => {
      const original = 'line1\r\nline2\r\nline3';
      const filePath = await writeFile('crlf-replace.txt', original);

      await InsertSnippet({ path: filePath, start: '2', end: '2', snippet: 'NEW2' }, state);

      const raw = await readFile(filePath);
      expect(raw).toBe('line1\r\nNEW2\r\nline3');
    });
  });
});
