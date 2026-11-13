import { HttpMacro } from '../macro';
import { createMockState } from '../../runtime/__tests__/support/mockState';

/**
 * The web macro returned **every** response header verbatim, `set-cookie` included.
 * A `set-cookie` header is a live session cookie for the fetched host, and the tool
 * result is appended to the conversation and sent to the model provider - so a fetch
 * of any authenticated page disclosed the caller's session.
 *
 * The fix strips credential-bearing headers and keeps the rest (content-type, cache
 * headers, rate limits are all useful to the agent).
 */

const makeResponse = (headerEntries: Array<[string, string]>, body = 'hello') => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: {
    get: (name: string) => {
      const found = headerEntries.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return found ? found[1] : null;
    },
    forEach: (callback: (value: string, key: string) => void) => {
      for (const [key, value] of headerEntries) callback(value, key);
    },
  },
  text: async () => body,
  json: async () => ({ ok: true }),
  blob: async () => ({ type: 'text/plain', size: body.length }),
});

describe('HttpMacro — response header hygiene', () => {
  const globalAny = global as any;
  const originalFetch = globalAny.fetch;

  afterEach(() => {
    globalAny.fetch = originalFetch;
  });

  it('drops set-cookie and other credential-bearing headers, keeping the rest', async () => {
    globalAny.fetch = jest.fn().mockResolvedValue(
      makeResponse([
        ['content-type', 'text/plain'],
        ['cache-control', 'no-store'],
        ['set-cookie', 'session=abc123; HttpOnly; Secure'],
        ['Set-Cookie', 'refresh=def456; HttpOnly'],
        ['authorization', 'Bearer upstream-token'],
        ['x-api-key', 'api-key-value'],
      ])
    ) as any;

    const state = createMockState({ vars: {}, user: { id: 'user-1' } });
    const result = await HttpMacro(
      { url: 'https://example.com/page', method: 'GET', returnFormat: 'text', cacheToWorkspace: false },
      state
    );

    expect(result.success).toBe(true);

    const headers = (result.data as any).headers as Record<string, string>;
    const headerNames = Object.keys(headers).map((name) => name.toLowerCase());

    expect(headerNames).not.toContain('set-cookie');
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('x-api-key');

    // Non-credential headers survive.
    expect(headers['content-type']).toBe('text/plain');
    expect(headers['cache-control']).toBe('no-store');

    // The whole serialised result is clean, not just `data.headers`.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('session=abc123');
    expect(serialised).not.toContain('refresh=def456');
    expect(serialised).not.toContain('upstream-token');
  });
});
