import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ListDirectory } from '../ListDirectory/ListDirectory';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

// Mock logger – the macro logs access and errors
jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

/**
 * Minimal ChatState stub used across all ListDirectory tests.
 */
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

// ── Temporary directory setup ──────────────────────────────────────────────
let tmpDir: string;

beforeAll(async () => {
  // Create a predictable temp directory tree:
  //   tmp/
  //   ├── alpha.txt        (11 bytes)
  //   ├── beta.json        (2 bytes)
  //   ├── gamma.ts         (0 bytes)
  //   └── sub/
  //       └── delta.txt    (5 bytes)
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'listdir-test-'));

  await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'hello world');
  await fs.writeFile(path.join(tmpDir, 'beta.json'), '{}');
  await fs.writeFile(path.join(tmpDir, 'gamma.ts'), '');

  const subDir = path.join(tmpDir, 'sub');
  await fs.mkdir(subDir);
  await fs.writeFile(path.join(subDir, 'delta.txt'), 'delta');
});

afterAll(async () => {
  // Clean up temp directory
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ListDirectory', () => {
  // ── Validation ──────────────────────────────────────────
  describe('validation', () => {
    it('should fail when path is empty', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: '' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No path');
    });

    it('should fail when path does not exist', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: '/no/such/directory' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should fail when path is a file, not a directory', async () => {
      const state = createMockState();
      const filePath = path.join(tmpDir, 'alpha.txt');
      const result = await ListDirectory({ path: filePath }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a directory');
    });
  });

  // ── Basic listing ───────────────────────────────────────
  describe('basic listing', () => {
    it('should list all items in a directory with default options', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // 3 files + 1 subdirectory = 4
      expect(result.data!.sum.t).toBe(4);
      expect(result.data!.sum.f).toBe(3);
      expect(result.data!.sum.d).toBe(1);
    });

    it('should return items with path and summary info', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.data!.p).toBe(tmpDir);
      expect(result.data!.pat).toBe('*');
      expect(result.data!.sub).toBe(false);
    });

    it('should populate tool and params on the result', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.tool).toBe('listDirectory');
      expect(result.params.path).toBe(tmpDir);
    });
  });

  // ── Pattern filter ──────────────────────────────────────
  describe('pattern filtering', () => {
    it('should filter files by pattern', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, pattern: '*.txt' }, state);

      expect(result.success).toBe(true);
      // Only alpha.txt should match the .txt pattern
      const fileItems = (result.data!.items as any[]).filter((i: any) => i.f);
      expect(fileItems.length).toBe(1);
      expect(fileItems[0].n).toContain('alpha');
    });

    it('should return no items when pattern matches nothing', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, pattern: '*.xyz' }, state);

      expect(result.success).toBe(true);
      expect(result.data!.sum.t).toBe(0);
    });
  });

  // ── Subfolders ──────────────────────────────────────────
  describe('subfolders', () => {
    it('should include subfolders recursively when subfolders=true', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, subfolders: true }, state);

      expect(result.success).toBe(true);
      // 3 root files + 1 sub dir + 1 sub file = 5
      expect(result.data!.sum.t).toBe(5);
    });
  });

  // ── Format ──────────────────────────────────────────────
  describe('format', () => {
    it('should produce text-formatted output by default', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, format: 'text' }, state);

      expect(result.success).toBe(true);
      expect(result.data!.fmt).toBe('text');
      // The text formatter includes filename and byte size
      expect(result.data!.out).toContain('alpha');
    });

    it('should produce JSON-formatted output when format=json', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, format: 'json' }, state);

      expect(result.success).toBe(true);
      expect(result.data!.fmt).toBe('json');
      // JSON output should be parseable (strip the code block wrapper first)
      const raw = result.data!.out
        .replace(/^```[^\n]*\n/, '')
        .replace(/\n```$/, '');
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('should wrap output in code blocks when escape=true (default)', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.data!.out).toMatch(/^```/);
    });

    it('should omit code blocks when escape=false', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir, escape: false }, state);

      expect(result.data!.out).not.toMatch(/^```/);
    });
  });

  // ── State side-effects ──────────────────────────────────
  describe('state side-effects', () => {
    it('should store lastListDirectory in state.vars', async () => {
      const state = createMockState();
      await ListDirectory({ path: tmpDir }, state);

      expect(state.vars.lastListDirectory).toBeDefined();
      const stored = state.vars.lastListDirectory as any;
      expect(stored.p).toBe(tmpDir);
      expect(stored.sum.t).toBe(4);
    });

    it('should initialise vars if it was undefined', async () => {
      const state = createMockState({ vars: undefined as any });
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.success).toBe(true);
      expect(state.vars).toBeDefined();
      expect(state.vars.lastListDirectory).toBeDefined();
    });
  });

  // ── Metadata ────────────────────────────────────────────
  describe('metadata', () => {
    it('should include execution time and user in metadata', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      expect(result.metadata).toBeDefined();
      expect(typeof result.metadata!.ms).toBe('number');
      expect(result.metadata!.u).toBe('user-test');
    });

    it('should include instructions naming the shorthand legend', async () => {
      const state = createMockState();
      const result = await ListDirectory({ path: tmpDir }, state);

      // The instructions are the model's only guide to the abbreviated keys, so
      // they must spell out the legend.
      expect(result.instructions).toBeDefined();
      expect(result.instructions).toContain('Directory listed');
      expect(result.instructions).toContain('shorthand n,e,s,d,f,p,m');
      expect(result.instructions).toContain('sum(t,f,d,s,sf)');
    });
  });
});
