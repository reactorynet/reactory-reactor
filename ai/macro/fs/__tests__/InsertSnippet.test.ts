import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import { InsertSnippet } from '../InsertSnippet/InsertSnippet';
import { MacroErrorCode } from '../../errors';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock `execFile` so we control what `lsof` reports in the open-handle
// guard. Same approach as the WriteFile test suite: promisify falls back
// to default callback semantics, so the last cb arg receives (err, value).
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

/** Configure the mocked lsof to report that no process holds the file open. */
function mockNoOpenHandles() {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
      const err: NodeJS.ErrnoException = new Error('no results');
      err.code = 1 as unknown as string; // lsof exits 1 when nothing matches
      cb(err);
    },
  );
}

/** Configure the mocked lsof to report the given PIDs as holding the file open. */
function mockOpenHandles(pids: string[]) {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
      cb(null, { stdout: pids.join('\n') + '\n', stderr: '' });
    },
  );
}

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

beforeEach(() => {
  execFileMock.mockReset();
  mockNoOpenHandles();
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
    it('returns structured error when path is empty', async () => {
      const result = await InsertSnippet({ path: '', start: '1', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_REQUIRED_PARAM);
      expect(result.error).toMatch(/path/i);
      expect(result.tool).toBe('insertText');
    });

    it('returns structured error when start is missing', async () => {
      const filePath = await writeFile('val-no-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_REQUIRED_PARAM);
      expect(result.error).toMatch(/start/i);
    });

    it('returns structured error when start is not a number', async () => {
      const filePath = await writeFile('val-nan-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: 'abc', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
      expect(result.error).toMatch(/start/i);
    });

    it('returns structured error when start is zero', async () => {
      const filePath = await writeFile('val-zero-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '0', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
      expect(result.error).toMatch(/start/i);
    });

    it('returns structured error when start exceeds file length', async () => {
      const filePath = await writeFile('val-oob-start.txt', 'a\nb\n');
      const result = await InsertSnippet({ path: filePath, start: '99', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
      expect(result.error).toMatch(/start.*beyond/i);
    });

    it('returns structured error when end is less than start', async () => {
      const filePath = await writeFile('val-end-lt-start.txt', 'a\nb\nc\n');
      const result = await InsertSnippet({ path: filePath, start: '3', end: '2', snippet: 'x' }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.VALIDATION_INVALID_PARAM);
      expect(result.error).toMatch(/end/i);
    });

    it('returns IO_NOT_FOUND for a non-existent file', async () => {
      const result = await InsertSnippet({
        path: path.join(tmpDir, 'no-such-file.txt'),
        start: '1',
        snippet: 'x',
      }, state);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_NOT_FOUND);
    });
  });

  // ── INSERT mode (no end given) ──────────────────────────────────────────
  describe('INSERT mode (no end)', () => {
    it('inserts snippet BEFORE the target line, preserving original content', async () => {
      // File with 5 lines; insert before line 3
      const original = 'line1\nline2\nline3\nline4\nline5';
      const filePath = await writeFile('insert-mid.txt', original);

      const result = await InsertSnippet({ path: filePath, start: '3', snippet: 'INSERTED' }, state);
      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('insert');

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

    it('instructions include a re-read reminder', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('reminder.txt', original);

      const result = await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet: 'REPLACED' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.instructions).toMatch(/re-read/i);
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

  // ── Exact removal + exact insertion contract ───────────────────────────
  // Pin down the byte-level guarantees that the macro is expected to
  // honour. These exist to make the contract explicit:
  //
  //   1. In REPLACE mode the [start..end] range is removed INCLUSIVELY
  //      with no off-by-one, and every byte outside that range is
  //      preserved verbatim.
  //   2. In INSERT mode the snippet is placed immediately before `start`
  //      and every original byte is preserved verbatim.
  //   3. With `exactMatch: true` the snippet itself is written byte-for-
  //      byte (no overlap trim) — this is the "verbatim" escape hatch.
  //   4. With the default (`exactMatch: false`), overlap detection MAY
  //      silently trim snippet edges that match adjacent file content.
  //      Callers who need verbatim insertion MUST set exactMatch: true.
  describe('exact removal + exact insertion contract', () => {
    it('REPLACE removes the [start..end] range inclusively with no off-by-one', async () => {
      // 10 lines. Replace [3..5] → lines 3, 4, AND 5 must be gone.
      const original = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10';
      const filePath = await writeFile('replace-inclusive.txt', original);

      await InsertSnippet(
        { path: filePath, start: '3', end: '5', snippet: 'X' },
        state,
      );

      const content = await readFile(filePath);
      expect(content.split('\n')).toEqual([
        'L1', 'L2', 'X', 'L6', 'L7', 'L8', 'L9', 'L10',
      ]);
      // Byte-level: compose the expected string explicitly so a future
      // off-by-one (e.g. leaving L5 in place) fails this assertion, not
      // just the array one above.
      expect(content).toBe('L1\nL2\nX\nL6\nL7\nL8\nL9\nL10');
    });

    it('REPLACE preserves every byte outside [start..end] verbatim', async () => {
      // Include leading/trailing whitespace and an internal blank line so
      // any trim() regression would change the byte count.
      const original = 'header\n  indented\n\nblank above\nKEEP_ME\ntail  ';
      const filePath = await writeFile('replace-preserve-outside.txt', original);

      // Replace only line 4 ("blank above"). Lines 1, 2, 3, 5, 6 must be
      // byte-identical to the original.
      await InsertSnippet(
        { path: filePath, start: '4', end: '4', snippet: 'REPLACED' },
        state,
      );

      const content = await readFile(filePath);
      const expected = 'header\n  indented\n\nREPLACED\nKEEP_ME\ntail  ';
      expect(content).toBe(expected);
    });

    it('REPLACE with an empty snippet leaves a single blank line (NOT a pure deletion — quirk worth knowing)', async () => {
      // Surfaced while writing the exact-removal contract: an empty
      // snippet is NOT treated as a pure deletion. `''.split('\n')`
      // yields `['']`, which becomes one empty line in the output, so
      // replacing [2..4] produces `A\n\nE`, not `A\nE`.
      //
      // Agents that need a true deletion must either (a) replace with
      // a snippet that re-echoes the surrounding context they want to
      // keep, or (b) reach for a different primitive. This test pins
      // the current behaviour down so a future change is intentional.
      const original = 'A\nB\nC\nD\nE';
      const filePath = await writeFile('replace-empty.txt', original);

      await InsertSnippet(
        { path: filePath, start: '2', end: '4', snippet: '' },
        state,
      );

      const content = await readFile(filePath);
      // One blank line sits where the removed range used to be.
      expect(content).toBe('A\n\nE');
      // No leftover bytes from B, C, or D — the *content* of the
      // removed range is gone, but a blank line placeholder remains.
      expect(content).not.toMatch(/[BCD]/);
    });

    it('REPLACE preserves the trailing newline when the edited range does not include it', async () => {
      const original = 'a\nb\nc\nd\n';
      const filePath = await writeFile('replace-trailing-nl.txt', original);

      // Replace line 2; the trailing \n (which becomes an empty final
      // "line" in the split representation) must survive.
      await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet: 'B2' },
        state,
      );

      const content = await readFile(filePath);
      expect(content).toBe('a\nB2\nc\nd\n');
    });

    it('INSERT places the snippet immediately before `start` and preserves every original byte', async () => {
      // Internal blank line + trailing spaces to catch any trim() regression.
      const original = 'first\n  spaced\n\nthird\ntrailing  ';
      const filePath = await writeFile('insert-exact.txt', original);

      await InsertSnippet(
        { path: filePath, start: '3', snippet: 'INJECT' },
        state,
      );

      const content = await readFile(filePath);
      // Original 4 lines are 100% intact; INJECT sits between line 2 and
      // the original line 3 (the blank line).
      expect(content).toBe('first\n  spaced\nINJECT\n\nthird\ntrailing  ');
    });

    it('INSERT preserves the trailing newline', async () => {
      const original = 'a\nb\nc\n';
      const filePath = await writeFile('insert-trailing-nl.txt', original);

      await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X' },
        state,
      );

      const content = await readFile(filePath);
      expect(content).toBe('a\nX\nb\nc\n');
    });

    it('exactMatch=true writes the snippet byte-for-byte even when edges duplicate adjacent content', async () => {
      // Snippet intentionally begins with the same line as the file's
      // line before `start` and ends with the same line as the file's
      // line after `end`. With exactMatch=true the macro must NOT trim
      // those edges — the duplication stays in the output, verbatim.
      const original = 'context\nbody\nfooter';
      const filePath = await writeFile('exactmatch-verbatim.txt', original);

      const snippet = 'context\nNEW_BODY\nfooter';
      await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet, exactMatch: true },
        state,
      );

      const content = await readFile(filePath);
      // Both duplicated edges are kept; raw byte equality, not just
      // line-array equality, so any silent trim would fail this.
      expect(content).toBe('context\ncontext\nNEW_BODY\nfooter\nfooter');
    });

    it('exactMatch=true preserves internal blank lines and trailing whitespace in the snippet', async () => {
      const original = 'top\nmiddle\nbottom';
      const filePath = await writeFile('exactmatch-whitespace.txt', original);

      // Snippet has an internal blank line and trailing spaces — both
      // must survive the round-trip verbatim.
      const snippet = 'mid_a\n\nmid_b   ';
      await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet, exactMatch: true },
        state,
      );

      const content = await readFile(filePath);
      expect(content).toBe('top\nmid_a\n\nmid_b   \nbottom');
    });

    it('default exactMatch=false silently trims overlapping edges (documenting the non-verbatim default)', async () => {
      // This is the inverse of the exactMatch test above and exists to
      // make the default contract explicit: by default the macro WILL
      // mutate the snippet when its edges overlap with neighbouring
      // file content. Agents that need verbatim insertion must opt in
      // via exactMatch: true.
      const original = 'context\nbody\nfooter';
      const filePath = await writeFile('default-trims.txt', original);

      const snippet = 'context\nNEW_BODY\nfooter';
      await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet },
        state,
      );

      const content = await readFile(filePath);
      // Both duplicated edges are stripped; result is verbatim-clean
      // (no duplicated context/footer lines).
      expect(content).toBe('context\nNEW_BODY\nfooter');
    });

    it('non-overlapping snippet is inserted verbatim even with default exactMatch=false', async () => {
      // When there is NO overlap, default mode is already verbatim.
      // This guards the "common case" so the trimOverlap safety net
      // doesn't start stripping non-duplicated content.
      const original = 'one\ntwo\nthree';
      const filePath = await writeFile('no-overlap-verbatim.txt', original);

      const snippet = 'A\nB\nC';
      await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet },
        state,
      );

      const content = await readFile(filePath);
      expect(content).toBe('one\nA\nB\nC\nthree');
    });
  });

  // ── Structured result + safety layers (parity with WriteFile) ────────
  // These exercise the new structured return shape and the two safety
  // layers ported over from WriteFile: the open-handle guard and the
  // post-write byte verification. Together they make InsertSnippet
  // report partial failures instead of returning an opaque success
  // string when a concurrent process mangles the file.
  describe('structured result + safety layers', () => {
    it('populates data fields with mode, line counts, and trim summary', async () => {
      const original = 'L1\nL2\nL3\nL4\nL5';
      const filePath = await writeFile('structured-replace.txt', original);

      // Replace lines 2..3 with a snippet that accidentally re-includes
      // L4 and L5 at its trailing edge — overlap detection should trim
      // 2 trailing lines, and that count must surface in data.
      const snippet = 'NEW2\nNEW3\nL4\nL5';
      const result = await InsertSnippet(
        { path: filePath, start: '2', end: '3', snippet },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        mode: 'replace',
        operation: 'replace',
        startLine: 2,
        endLine: 3,
        linesBefore: 1,
        linesAfter: 2,
        snippetLines: 4,
        insertedLines: 2,
        trimmedLeading: 0,
        trimmedTrailing: 2,
        exactMatch: false,
        totalLines: 5,
      });
      expect(result.data?.sizeFormatted).toMatch(/KB$/);
    });

    it('reports exactMatch=true and zero trim counts when the escape hatch is used', async () => {
      const original = 'context\nbody\nfooter';
      const filePath = await writeFile('structured-exactmatch.txt', original);

      const snippet = 'context\nNEW_BODY\nfooter';
      const result = await InsertSnippet(
        { path: filePath, start: '2', end: '2', snippet, exactMatch: true },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        mode: 'replace',
        exactMatch: true,
        trimmedLeading: 0,
        trimmedTrailing: 0,
        insertedLines: 3,
      });
    });

    it('stores lastInsertSnippet summary in state.vars', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('state-vars.txt', original);
      const localState = createMockState();

      await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X' },
        localState,
      );

      const stored = (localState.vars as any).lastInsertSnippet;
      expect(stored).toBeDefined();
      expect(stored.path).toBe(filePath);
      expect(stored.mode).toBe('insert');
      expect(stored.startLine).toBe(2);
      expect(stored.endLine).toBe(1); // startLine - 1 in INSERT mode
      expect(stored.trimmedLeading).toBe(0);
      expect(stored.trimmedTrailing).toBe(0);
      expect(stored.exactMatch).toBe(false);
      // Cross-realm Date means `toBeInstanceOf(Date)` is unreliable here;
      // assert the shape instead.
      expect(typeof stored.lastModified).toBe('object');
      expect(typeof stored.lastModified.toISOString).toBe('function');
    });

    it('blocks the edit when a foreign PID holds the file open', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('open-handles.txt', original);
      mockOpenHandles(['99999']); // a PID that is not ours

      const result = await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_PERMISSION_DENIED);
      expect(result.metadata?.operationType).toBe('blocked_open_handles');
      expect(result.error).toMatch(/99999/);
      // File content must be unchanged.
      expect(await readFile(filePath)).toBe(original);
    });

    it('ignores its own PID when scanning open handles', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('self-handle.txt', original);
      mockOpenHandles([String(process.pid)]);

      const result = await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X' },
        state,
      );

      expect(result.success).toBe(true);
      expect(await readFile(filePath)).toBe('a\nX\nb\nc');
    });

    it('returns IO_READ_WRITE_ERROR when the post-write verification read differs from intended', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('verify-mismatch.txt', original);

      // The macro writes, then reads back to verify. Intercept only the
      // verification read (the second readFile call) and return bytes
      // that differ from what we just wrote.
      const readSpy = jest
        .spyOn(fs, 'readFile')
        .mockImplementationOnce(async () => 'a\nb\nc' as any)   // initial read
        .mockImplementationOnce(async () => 'TAMPERED-LONGER' as any); // verification

      const result = await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X' },
        state,
      );

      readSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(MacroErrorCode.IO_READ_WRITE_ERROR);
      expect(result.metadata?.operationType).toBe('verification_failed');
      expect(result.error).toMatch(/verification failed/i);
    });

    it('instructions field is populated and mentions line-count change', async () => {
      const original = 'a\nb\nc';
      const filePath = await writeFile('instructions.txt', original);

      const result = await InsertSnippet(
        { path: filePath, start: '2', snippet: 'X\nY' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.instructions).toBeTruthy();
      expect(result.instructions).toMatch(/InsertSnippet Results/i);
      expect(result.instructions).toMatch(/line.*changed|line numbers/i);
    });

    it('params and tool are echoed back on every result', async () => {
      const filePath = await writeFile('echo-params.txt', 'a\nb');
      const params = { path: filePath, start: '1', end: '1', snippet: 'Z', exactMatch: true };

      const result = await InsertSnippet(params, state);

      expect(result.success).toBe(true);
      expect(result.tool).toBe('insertText');
      expect(result.params).toEqual(params);
    });
  });
});
