import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { WriteFile } from '../WriteFile/WriteFile';
import { SafeEditFile } from '../SafeEditFile/SafeEditFile';
import { digestPayload, summarisePayload } from '../payloadSummary';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * Guard for the property the ToolResultProcessor tests cannot reach: a macro's result must not
 * **echo the payload the caller sent**.
 *
 * `writeFile` used to return the content twice (`params.content` and `data.content`), and
 * `safeEditFile` returned every `search`/`replace` block. Every one of those bytes went into the
 * conversation as the tool result — the caller's own input, re-sent at full size, growing without
 * bound with the payload. That is how a large write could exhaust a session's context budget.
 *
 * The replacement is a digest: size, line count, hash and a **bounded** preview. A preview is
 * deliberate — it confirms the right payload landed — so these tests place their markers *beyond*
 * the preview window. A marker inside the first 160 characters would be legitimately present and
 * asserting its absence would be wrong; placing it past the window makes "not present" a real
 * claim about the bulk of the payload rather than about the preview.
 */

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;

/** lsof exits 1 when nothing matches, which the open-handle guard reads as "not held open". */
const mockNoOpenHandles = () => {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, value?: unknown) => void) => {
      const err: NodeJS.ErrnoException = new Error('no results');
      err.code = 1 as unknown as string;
      cb(err);
    }
  );
};

const createState = (): ChatState =>
  ({
    id: 'test-session',
    host: 'server',
    personaId: 'test-persona',
    persona: { id: 'test-persona', name: 'Test' },
    user: { _id: { toString: () => 'tester' }, id: 'tester' },
    vars: {},
    history: [],
    tools: [],
    macros: [],
    context: {},
  } as any);

const sha16 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** A payload whose distinguishing marker sits well past the preview window. */
const payloadWithMarker = (marker: string, filler = 'x', half = 10000) =>
  filler.repeat(half) + marker + filler.repeat(half);

describe('payloadSummary', () => {
  it('counts characters, bytes and lines and hashes the payload', () => {
    const text = 'one\ntwo\nthree';
    const digest = digestPayload(text);

    expect(digest.omitted).toBe(true);
    expect(digest.chars).toBe(text.length);
    expect(digest.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(digest.lines).toBe(3);
    expect(digest.sha256).toBe(sha16(text));
  });

  it('bounds the preview regardless of how the payload is shaped', () => {
    // A single enormous line must not smuggle its size past the bound.
    const digest = digestPayload('x'.repeat(500000));

    expect(digest.chars).toBe(500000);
    expect(digest.preview.length).toBeLessThanOrEqual(160);
    expect(digest.previewChars).toBeLessThanOrEqual(160);
  });

  it('collapses whitespace in the preview so a multi-line head stays one line', () => {
    const digest = digestPayload('alpha\n\n   beta\t gamma', { previewChars: 100 });
    expect(digest.preview).toBe('alpha beta gamma');
  });

  it('can preview the tail instead of the head', () => {
    const digest = digestPayload('HEAD-middle-TAIL', { previewChars: 4, tail: true });
    expect(digest.preview).toBe('TAIL');
  });

  it('describes an empty payload without pretending it has content', () => {
    expect(digestPayload('').chars).toBe(0);
    expect(digestPayload('').lines).toBe(0);
    expect(summarisePayload('', 'content')).toBe('[content: empty]');
  });

  it('handles a non-string payload by digesting its serialised form', () => {
    const serialised = JSON.stringify({ a: 1, b: 'two' });
    const digest = digestPayload({ a: 1, b: 'two' });

    expect(digest.chars).toBe(serialised.length);
    expect(digest.sha256).toBe(sha16(serialised));
  });

  it('keeps the one-line form small even for a megabyte payload', () => {
    const summary = summarisePayload('z'.repeat(1024 * 1024), 'content');

    expect(summary.length).toBeLessThan(400);
    expect(summary).toContain('1048576 chars');
  });
});

describe('writeFile does not echo the content it was given', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'payload-summary-'));
  });

  afterAll(async () => {
    // `fs.promises.rm` is absent from this project's @types/node, so clean up with the
    // long-standing readdir/unlink/rmdir trio.
    const entries = await fsp.readdir(tmpDir);
    await Promise.all(entries.map((entry) => fsp.unlink(path.join(tmpDir, entry))));
    await fsp.rmdir(tmpDir);
  });

  beforeEach(() => mockNoOpenHandles());

  it('returns a digest instead of the payload, and the bulk of the payload is absent', async () => {
    const state = createState();
    const payload = payloadWithMarker('PAYLOAD-MARKER-INSIDE', 'Q');
    const filePath = path.join(tmpDir, 'big.txt');

    const result = await WriteFile({ path: filePath, content: payload, mode: 'overwrite' }, state);

    expect(result.success).toBe(true);

    // 1. The bytes really did land — the change must not cost correctness.
    expect(await fsp.readFile(filePath, 'utf8')).toBe(payload);

    // 2. The payload beyond the preview window is NOT in the result.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('PAYLOAD-MARKER-INSIDE');
    expect(serialised).not.toContain('Q'.repeat(200));

    // 3. What remains is bounded, and the payload is ~20000 chars.
    expect(serialised.length).toBeLessThan(4000);
    expect(result.data!.contentDigest.preview.length).toBeLessThanOrEqual(160);

    // 4. `params.content` is a digest string, not content.
    expect(typeof result.params.content).toBe('string');
    expect(result.params.content).toContain('omitted from this result');
    expect(result.params.content).toContain(`${payload.length} chars`);

    // 5. `data.content` is a digest, and `contentDigest` is enough to verify the write.
    expect(result.data!.content).toContain('omitted from this result');
    expect(result.data!.contentDigest.sha256).toBe(sha16(payload));
    expect(result.data!.contentDigest.chars).toBe(payload.length);
    expect(result.data!.contentDigest.omitted).toBe(true);
    expect(result.data!.size).toBe(Buffer.byteLength(payload, 'utf8'));
  });

  it('does not persist the payload into state.vars (which is written to the conversation document)', async () => {
    const state = createState();
    const payload = payloadWithMarker('VARS-MARKER-INSIDE', 'v');
    const filePath = path.join(tmpDir, 'vars.txt');

    await WriteFile({ path: filePath, content: payload, mode: 'overwrite' }, state);

    const stored = JSON.stringify((state.vars as any).lastWriteFile);

    expect(stored).not.toContain('VARS-MARKER-INSIDE');
    expect(stored).not.toContain('v'.repeat(200));
    expect(stored.length).toBeLessThan(2000);

    // Still useful: the path survives, so a later reader knows what was written.
    expect((state.vars as any).lastWriteFile.path).toBe(filePath);
    expect(stored).toContain('omitted from this result');
  });
});

describe('safeEditFile does not echo the patch blocks it was given', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safe-edit-summary-'));
  });

  afterAll(async () => {
    // `fs.promises.rm` is absent from this project's @types/node, so clean up with the
    // long-standing readdir/unlink/rmdir trio.
    const entries = await fsp.readdir(tmpDir);
    await Promise.all(entries.map((entry) => fsp.unlink(path.join(tmpDir, entry))));
    await fsp.rmdir(tmpDir);
  });

  it('returns digests of the search/replace blocks, and applies the patch', async () => {
    const state = createState();
    const filePath = path.join(tmpDir, 'edit.txt');
    const search = payloadWithMarker('SEARCH-MARKER-INSIDE', 's');
    const replace = payloadWithMarker('REPLACE-MARKER-INSIDE', 'r');
    await fsp.writeFile(filePath, `before\n${search}\nafter\n`, 'utf8');

    const result = await SafeEditFile({ path: filePath, patches: [{ search, replace }] }, state);

    expect(result.success).toBe(true);
    expect(result.data!.patchesApplied).toBe(1);

    // The patch really applied.
    expect(await fsp.readFile(filePath, 'utf8')).toBe(`before\n${replace}\nafter\n`);

    // Neither block's bulk appears in the result.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('SEARCH-MARKER-INSIDE');
    expect(serialised).not.toContain('REPLACE-MARKER-INSIDE');
    expect(serialised).not.toContain('s'.repeat(200));
    expect(serialised).not.toContain('r'.repeat(200));
    expect(serialised.length).toBeLessThan(4000);

    // The params carry per-block digests, preserving the array shape and the readable path.
    expect(result.params.patches).toHaveLength(1);
    expect(result.params.patches[0].search).toContain('omitted from this result');
    expect(result.params.patches[0].search).toContain('patches[0].search');
    expect(result.params.patches[0].replace).toContain('patches[0].replace');
    expect(result.params.patches[0].search).toContain(`${search.length} chars`);
    expect(result.params.path).toBe(filePath);
  });
});
