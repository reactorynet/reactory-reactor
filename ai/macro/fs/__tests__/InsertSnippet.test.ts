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

  // ── Overlap detection ──────────────────────────────────────────────────
  describe('overlap detection', () => {
    it('trims trailing snippet lines that duplicate lines after end', async () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('overlap-trailing.txt', original);

      // Snippet replaces lines 2-3 but accidentally includes line4+line5
      const snippet = 'NEW2\nNEW3\nline4\nline5';
      await InsertSnippet({ path: filePath, start: '2', end: '3', snippet }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'NEW2', 'NEW3', 'line4', 'line5']);
    });

    it('trims leading snippet lines that duplicate lines before start', async () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('overlap-leading.txt', original);

      // Snippet replaces lines 3-4 but accidentally starts with line2
      const snippet = 'line2\nNEW3\nNEW4';
      await InsertSnippet({ path: filePath, start: '3', end: '4', snippet }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'line2', 'NEW3', 'NEW4', 'line5']);
    });

    it('trims overlap on both sides', async () => {
      const original = 'A\nB\nC\nD\nE';
      const filePath = await writeFile('overlap-both.txt', original);

      // Snippet replaces line 3 but echoes B at start and D at end
      const snippet = 'B\nNEW_C\nD';
      await InsertSnippet({ path: filePath, start: '3', end: '3', snippet }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['A', 'B', 'NEW_C', 'D', 'E']);
    });

    it('does not trim when there is no overlap', async () => {
      const original = 'line1\nline2\nline3';
      const filePath = await writeFile('overlap-none.txt', original);

      await InsertSnippet({ path: filePath, start: '2', end: '2', snippet: 'REPLACED' }, state);

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'REPLACED', 'line3']);
    });
  });

  // ── Sequential edits with fresh line numbers ──────────────────────────
  describe('sequential edits (re-read between edits)', () => {
    it('handles consecutive edits when the AI uses fresh line numbers', async () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('seq-edits.txt', original);
      const seqState = createMockState();

      // First edit: insert 2 lines before line 2 (adds 2 lines)
      await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X\nY' },
        seqState,
      );

      // AI re-reads: file is now line1, X, Y, line2, line3, line4, line5 (7 lines)
      // Second edit: replace line 6 (was original "line4", now at position 6)
      await InsertSnippet(
        { path: filePath, start: '6', end: '6', snippet: 'REPLACED4' },
        seqState,
      );

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual([
        'line1', 'X', 'Y', 'line2', 'line3', 'REPLACED4', 'line5',
      ]);
    });

    it('handles edit before a previous edit point without corruption', async () => {
      // This is the exact pattern that caused the ToolsPanel.tsx corruption:
      // edit at high line number, then edit at lower line number
      const original = 'A\nB\nC\nD\nE\nF\nG\nH\nI\nJ';
      const filePath = await writeFile('seq-before-after.txt', original);
      const seqState = createMockState();

      // First edit at a high line: replace lines 8-9 with 3 lines (+1 net)
      await InsertSnippet(
        { path: filePath, start: '8', end: '9', snippet: 'H2\nI2\nNEW' },
        seqState,
      );

      // AI re-reads: A, B, C, D, E, F, G, H2, I2, NEW, J (11 lines)
      // Second edit at a LOW line: replace lines 2-3 (B, C) with 1 line (-1 net)
      await InsertSnippet(
        { path: filePath, start: '2', end: '3', snippet: 'BC' },
        seqState,
      );

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual([
        'A', 'BC', 'D', 'E', 'F', 'G', 'H2', 'I2', 'NEW', 'J',
      ]);
    });

    it('does not store fileLineOffsets in state.vars', async () => {
      const original = 'a\nb\nc\nd\ne';
      const filePath = await writeFile('no-offsets.txt', original);
      const seqState = createMockState();

      await InsertSnippet(
        { path: filePath, start: '1', snippet: 'X\nY\nZ' },
        seqState,
      );

      expect((seqState.vars as any).fileLineOffsets).toBeUndefined();
    });

    it('success message includes re-read reminder', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('reminder.txt', original);

      const result = await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet: 'REPLACED' },
        state,
      );

      expect(result).toMatch(/re-read/i);
    });
  });

  // ── exactMatch escape hatch + structural-line refinement ──────────────
  // Per InsertSnippet_Fix_Spec: prevent the false-positive trim that
  // strips a snippet's closing brace when the next file line is also a
  // closing brace (parent scope). Two safety layers: (1) the exactMatch
  // flag bypasses overlap detection entirely; (2) by default, overlap
  // matches consisting purely of structural lines (blank, lone closers)
  // are skipped.
  describe('exactMatch + structural-line overlap refinement', () => {
    it('does NOT strip a closing brace when file-after also starts with a closing brace (structural-line refinement)', async () => {
      // The bug pattern: replacing the inner `if` block; snippet ends
      // with `  }` (the inner block's own close); the file's next line
      // is `}` closing the outer function. Under the old behaviour the
      // inner `}` was stripped, breaking syntax.
      const original = [
        'function outer() {',
        '  if (x) {',
        '    return 1;',
        '  }',
        '}',
      ].join('\n');
      const filePath = await writeFile('overlap-structural-bug.txt', original);

      // Replace lines 2..4 (the if-block body) with a new if-block that
      // again ends with `  }`. The next file line (line 5 of the
      // original) is `}` — same shape, different scope.
      const snippet = ['  if (y) {', '    return 2;', '  }'].join('\n');
      await InsertSnippet(
        { path: filePath, start: '2', end: '4', snippet },
        state,
      );

      const content = await readFile(filePath);
      // The inner `}` MUST still be present — five lines total, well-formed.
      expect(content.split('\n')).toEqual([
        'function outer() {',
        '  if (y) {',
        '    return 2;',
        '  }',
        '}',
      ]);
    });

    it('does NOT strip a leading blank line that matches a blank line before start', async () => {
      const original = ['header', '', 'mid', 'tail'].join('\n');
      const filePath = await writeFile('overlap-blank-leading.txt', original);

      // Snippet starts with a blank line; line before start is also blank.
      // Under the structural-only-skip rule the blank line MUST stay.
      const snippet = ['', 'NEW1', 'NEW2'].join('\n');
      await InsertSnippet(
        { path: filePath, start: '3', end: '3', snippet },
        state,
      );

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['header', '', '', 'NEW1', 'NEW2', 'tail']);
    });

    it('exactMatch=true bypasses overlap trim even when a non-structural overlap exists', async () => {
      // Recreate the existing "trims trailing snippet lines" scenario but
      // with exactMatch=true — the trim should NOT happen, so the
      // duplicated line4/line5 stays in the output.
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('exactmatch-trailing.txt', original);

      const snippet = 'NEW2\nNEW3\nline4\nline5';
      await InsertSnippet(
        { path: filePath, start: '2', end: '3', snippet, exactMatch: true },
        state,
      );

      const content = await readFile(filePath);
      // exactMatch preserves the snippet verbatim, producing a
      // duplicated tail. The contract is "exact insertion"; the AI
      // accepts responsibility for the result.
      expect(content.split('\n')).toEqual([
        'line1', 'NEW2', 'NEW3', 'line4', 'line5', 'line4', 'line5',
      ]);
    });

    it('exactMatch=false (default) still trims real-content overlaps (no regression)', async () => {
      // Same setup as the test above but without exactMatch — the trim
      // SHOULD fire because the overlapping lines are not structural.
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('default-trim-still-works.txt', original);

      const snippet = 'NEW2\nNEW3\nline4\nline5';
      await InsertSnippet(
        { path: filePath, start: '2', end: '3', snippet },
        state,
      );

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual(['line1', 'NEW2', 'NEW3', 'line4', 'line5']);
    });

    it('still trims when overlap mixes structural and non-structural lines (mixed candidate is acceptable signal)', async () => {
      // The structural-only safety only kicks in when EVERY line of the
      // candidate trim is structural. A mixed candidate (real content
      // PLUS a brace) is still a valid signal of accidental duplication
      // and should still trim.
      const original = 'A\nrealLine\n}\nC\nD';
      const filePath = await writeFile('overlap-mixed.txt', original);

      // Replace `realLine\n}` with a snippet that accidentally re-includes
      // both the realLine AND the `}` at the leading edge.
      const snippet = 'realLine\n}\nNEW';
      await InsertSnippet(
        { path: filePath, start: '2', end: '3', snippet },
        state,
      );

      const content = await readFile(filePath);
      // The `realLine\n}` 2-line prefix matches; not-all-structural →
      // trim fires; result has just the NEW line in that slot.
      expect(content.split('\n')).toEqual(['A', 'realLine', '}', 'NEW', 'C', 'D']);
    });
  });
});
