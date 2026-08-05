import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReadFile, PathInfoMacro, ExtractTextFromFile } from './macro';
import TestChatState from '../data/tests/mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * Covers the fs macros that have no suite of their own.
 *
 * ListDirectory, WriteFile and InsertSnippet are covered in depth by
 * `./__tests__/*.test.ts`. This file used to duplicate them against the
 * deprecated positional-array API (`ReadFile([filePath])` resolving to a bare
 * string), which no longer exists — every macro now takes a props object and
 * resolves a structured `{ success, data | error, tool, params }` result. It
 * also wrote into the checked-in `./samples` fixtures, so a failing run left
 * them modified; each test now works in its own temp directory.
 */

describe('fs macros', () => {
  let chatState: ChatState;
  let workDir: string;

  beforeEach(async () => {
    chatState = await TestChatState({ macros: [] });
    // Under the home directory, not os.tmpdir(): ReadFile sandboxes reads to
    // `os.homedir()` and rejects anything outside it, and on macOS tmpdir is
    // /var/folders/... which is not under home.
    workDir = fs.mkdtempSync(path.join(os.homedir(), '.reactor-fs-macro-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const writeFixture = (name: string, content: string): string => {
    const target = path.join(workDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  };

  describe('ReadFile', () => {
    it('returns the content plus a fenced code block and metadata', async () => {
      const target = writeFixture('notes.md', '# Title\n\nBody line.\n');
      const result = await ReadFile({ path: target }, chatState);

      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('# Title');
      expect(result.data?.codeBlock).toContain('```');
      // The macro resolves symlinks, so compare against the canonical path.
      expect(result.data?.metadata.path).toBe(fs.realpathSync(target));
      expect(result.data?.metadata.size).toBeGreaterThan(0);
    });

    it('reports a missing path as a validation error rather than throwing', async () => {
      const result = await ReadFile({ path: '' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No path provided');
      expect(result.tool).toBe('readFile');
    });

    it('reports a non-existent file as an error', async () => {
      const result = await ReadFile({ path: path.join(workDir, 'absent.txt') }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/File not found/);
    });

    it('refuses to read outside the home directory', async () => {
      const result = await ReadFile({ path: '/etc/hosts' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/only read files in your home directory/);
    });
  });

  describe('PathInfoMacro', () => {
    it('describes a file and records it on the chat state', async () => {
      const target = writeFixture('thing.txt', 'hello');
      const result = await PathInfoMacro({ path: target }, chatState);

      expect(result.success).toBe(true);
      expect(result.data?.pathInfo).toMatchObject({ isFile: true, isDirectory: false });
      expect(result.data?.summary).toMatchObject({ type: 'File' });
      // Recorded so later macros in the same conversation can refer back to it.
      expect(chatState.vars.lastPathInfo).toMatchObject({ path: target });
    });

    it('describes a directory', async () => {
      const result = await PathInfoMacro({ path: workDir }, chatState);
      expect(result.success).toBe(true);
      expect(result.data?.pathInfo).toMatchObject({ isDirectory: true, isFile: false });
      expect(result.data?.summary.type).toBe('Directory');
    });

    it('reports a missing path as a validation error', async () => {
      const result = await PathInfoMacro({ path: '' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No path provided');
      expect(result.tool).toBe('pathInfo');
    });
  });

  describe('ExtractTextFromFile', () => {
    const lines = ['one', 'two', 'three', 'four', 'five'];
    const fixture = () => writeFixture('lines.txt', `${lines.join('\n')}\n`);

    it('extracts an inclusive line range', async () => {
      const result = await ExtractTextFromFile({ path: fixture(), start: 2, end: 4 }, chatState);

      expect(result.success).toBe(true);
      expect(result.data?.extractedText).toContain('two');
      expect(result.data?.extractedText).toContain('four');
      expect(result.data?.extractedText).not.toContain('one');
      expect(result.data?.extractedText).not.toContain('five');
      expect(result.data?.lineRange).toMatchObject({ start: 2, end: 4 });
    });

    it('extracts a single line when start equals end', async () => {
      const result = await ExtractTextFromFile({ path: fixture(), start: 2, end: 2 }, chatState);
      expect(result.success).toBe(true);
      expect(result.data?.extractedText).toContain('two');
      expect(result.data?.extractedText).not.toContain('three');
    });

    it('reports a missing path as a validation error', async () => {
      const result = await ExtractTextFromFile({ path: '', start: 1, end: 2 }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No path provided');
      expect(result.tool).toBe('extractTextFromFile');
    });
  });
});
