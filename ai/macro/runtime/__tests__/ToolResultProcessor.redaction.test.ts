import fs from 'fs';
import ToolResultProcessor from '../ToolResultProcessor';

/**
 * A serialised User document, exactly the shape that leaked: PBKDF2 hash, salt,
 * refresh tokens under `sessionInfo`, and third-party OAuth access tokens under
 * `authentications`.
 */
const userDocument = () => ({
  _id: '5f1d7f000000000000000001',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  password: 'pbkdf2$10000$abcdef$0123456789abcdef',
  salt: 'c0ffee-c0ffee-c0ffee',
  memberships: [{ roles: ['ADMIN'] }],
  sessionInfo: [
    {
      jwtToken: 'header.payload.signature',
      jwtPayload: { sub: '5f1d7f000000000000000001', roles: ['ADMIN'] },
      jwtPayloadJson: '{"sub":"5f1d7f000000000000000001"}',
      refresh: 'refresh-token-value',
      refreshToken: 'refresh-token-value',
    },
  ],
  authentications: [
    { provider: 'google', props: { accessToken: 'ya29.secret-access-token' } },
  ],
});

const CREDENTIAL_VALUES = [
  'pbkdf2$10000$abcdef$0123456789abcdef',
  'c0ffee-c0ffee-c0ffee',
  'header.payload.signature',
  'refresh-token-value',
  'ya29.secret-access-token',
];

const expectNoCredentialMaterial = (serialised: string) => {
  for (const value of CREDENTIAL_VALUES) {
    expect(serialised).not.toContain(value);
  }
};

describe('ToolResultProcessor — credential redaction', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    createdFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (e) { /* ignore */ }
      }
    });
    createdFiles.length = 0;
  });

  it('redacts a full user document carried in data, keeping the result shape', () => {
    const rawResult = {
      success: true,
      data: { user: userDocument(), status: 'active' },
      tool: 'getUser',
      params: { email: 'ada@example.com' },
    };

    const processed = ToolResultProcessor.process(
      'getUser',
      { email: 'ada@example.com' },
      rawResult,
      undefined,
      undefined,
      { maxOutputSize: 20000 }
    );

    expect(processed.outputTruncated).toBe(false);
    expectNoCredentialMaterial(JSON.stringify(processed.result));

    const user = processed.result.data.user;
    // Shape preserved: the keys are still there, only their values changed.
    expect(user.password).toBe(ToolResultProcessor.REDACTED);
    expect(user.salt).toBe(ToolResultProcessor.REDACTED);
    expect(user.sessionInfo).toBe(ToolResultProcessor.REDACTED);
    expect(user.authentications).toBe(ToolResultProcessor.REDACTED);
    expect(user.memberships).toBe(ToolResultProcessor.REDACTED);
    // Non-sensitive identity fields survive untouched.
    expect(user.firstName).toBe('Ada');
    expect(user.email).toBe('ada@example.com');
    expect(processed.result.data.status).toBe('active');
  });

  it('redacts nested credential keys before an oversized payload is written to disk', () => {
    // Deliberately under nothing: the payload is far larger than the threshold, so this
    // exercises the offload branch — the exact path that used to persist a leak.
    const padded = userDocument() as any;
    padded.notes = 'N'.repeat(4000);

    const rawResult = {
      success: true,
      data: { user: padded },
      tool: 'getUser',
      params: { email: 'ada@example.com' },
    };

    const processed = ToolResultProcessor.process(
      'getUser',
      { email: 'ada@example.com' },
      rawResult,
      undefined,
      undefined,
      { maxOutputSize: 500 }
    );

    expect(processed.outputTruncated).toBe(true);
    expect(processed.outputFile).toBeDefined();
    createdFiles.push(processed.outputFile!);

    // The in-context result is clean...
    expectNoCredentialMaterial(JSON.stringify(processed.result));

    // ...and so is the artefact. This is the acceptance criterion: read the file back.
    const saved = fs.readFileSync(processed.outputFile!, 'utf8');
    expectNoCredentialMaterial(saved);
    expect(saved).toContain(ToolResultProcessor.REDACTED);
  });

  it('redacts credential-bearing request headers echoed in params and metadata', () => {
    const rawResult = {
      success: true,
      data: { status: 200 },
      metadata: {
        user: '5f1d7f000000000000000001',
        request: {
          headers: {
            authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
            'set-cookie': 'session=abc123; HttpOnly',
            'x-api-key': 'api-key-value',
          },
        },
      },
      params: {
        url: 'https://example.com',
        authorization: 'Bearer secret-bearer',
        'Set-Cookie': ['a=b', 'c=d'],
        clientSecret: 'super-secret',
      },
      tool: 'http',
    };

    const processed = ToolResultProcessor.process(
      'http',
      { url: 'https://example.com' },
      rawResult,
      undefined,
      undefined,
      { maxOutputSize: 20000 }
    );

    const serialised = JSON.stringify(processed.result);
    expect(serialised).not.toContain('Bearer secret-bearer');
    expect(serialised).not.toContain('api-key-value');
    expect(serialised).not.toContain('super-secret');
    expect(serialised).not.toContain('session=abc123');

    expect(processed.result.metadata.request.headers.authorization).toBe(
      ToolResultProcessor.REDACTED
    );
    expect(processed.result.metadata.request.headers['set-cookie']).toBe(
      ToolResultProcessor.REDACTED
    );
    expect(processed.result.params.clientSecret).toBe(ToolResultProcessor.REDACTED);
    // ``metadata.user`` stays a string id — reactory-3315967211 acceptance criterion.
    expect(typeof processed.result.metadata.user).toBe('string');
  });

  it('survives a cyclic result without hanging and still serialises', () => {
    const cyclic: any = { name: 'root', password: 'pbkdf2$cyclic' };
    cyclic.self = cyclic;
    cyclic.children = [{ parent: cyclic }];

    const processed = ToolResultProcessor.process(
      'cyclicTool',
      {},
      { success: true, data: cyclic },
      undefined,
      undefined,
      { maxOutputSize: 20000 }
    );

    expect(processed.result.data.password).toBe(ToolResultProcessor.REDACTED);
    expect(() => JSON.stringify(processed.result)).not.toThrow();
  });

  it('redacts every reference to a shared user document, not just the first', () => {
    const shared = userDocument();
    const rawResult = {
      success: true,
      data: { createdBy: shared, updatedBy: shared },
    };

    const processed = ToolResultProcessor.process(
      'getSupportTicket',
      {},
      rawResult,
      undefined,
      undefined,
      { maxOutputSize: 20000 }
    );

    expect(processed.result.data.createdBy.password).toBe(ToolResultProcessor.REDACTED);
    expect(processed.result.data.updatedBy.password).toBe(ToolResultProcessor.REDACTED);
    expect(JSON.stringify(processed.result)).not.toContain('[Circular]');
  });

  it('normalises key names when deciding sensitivity', () => {
    expect(ToolResultProcessor.isSensitiveKey('set-cookie')).toBe(true);
    expect(ToolResultProcessor.isSensitiveKey('setCookie')).toBe(true);
    expect(ToolResultProcessor.isSensitiveKey('SET_COOKIE')).toBe(true);
    expect(ToolResultProcessor.isSensitiveKey('password')).toBe(true);
    expect(ToolResultProcessor.isSensitiveKey('displayName')).toBe(false);
  });

  it('leaves a benign result untouched', () => {
    const rawResult = {
      success: true,
      data: { path: '/tmp/a.ts', content: 'const a = 1;', lines: 1 },
      metadata: { executionTime: 4, timestamp: new Date('2026-01-01T00:00:00.000Z') },
      params: { path: '/tmp/a.ts' },
    };

    const processed = ToolResultProcessor.process(
      'readFile',
      { path: '/tmp/a.ts' },
      rawResult,
      undefined,
      undefined,
      { maxOutputSize: 20000 }
    );

    expect(processed.result).toEqual(rawResult);
  });
});

describe('ToolResultProcessor — string payloads and the depth ceiling', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    createdFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (e) { /* ignore */ }
      }
    });
    createdFiles.length = 0;
  });

  it('redacts a JSON *string* result and writes a clean file when it is offloaded', () => {
    // The graphql macro returns `JSON.stringify(result)` and the data macros return
    // `JSON.stringify(rows)`, so a string result is a normal shape. This used to bypass
    // redaction entirely and be written to `<tool>-output-*.log` verbatim.
    const payload = JSON.stringify({
      users: [
        {
          email: 'ada@example.com',
          password: 'pbkdf2$10000$deadbeef$cafebabe',
          salt: 'salty-salt',
          sessionInfo: [{ refresh: 'refresh-token-value' }],
        },
      ],
      pad: 'N'.repeat(3000),
    });

    const processed = ToolResultProcessor.process(
      'queryGQL',
      {},
      payload,
      undefined,
      undefined,
      { maxOutputSize: 500 }
    );

    expect(processed.outputTruncated).toBe(true);
    expect(processed.outputFile).toBeDefined();
    createdFiles.push(processed.outputFile!);

    const saved = fs.readFileSync(processed.outputFile!, 'utf8');
    expect(saved).not.toContain('pbkdf2');
    expect(saved).not.toContain('salty-salt');
    expect(saved).not.toContain('refresh-token-value');

    // The artefact is still valid JSON with the shape intact.
    const parsed = JSON.parse(saved);
    expect(parsed.users[0].email).toBe('ada@example.com');
    expect(parsed.users[0].password).toBe(ToolResultProcessor.REDACTED);

    // ...and the in-context result never carries the payload at all.
    expect(JSON.stringify(processed.result)).not.toContain('pbkdf2');
  });

  it('scrubs credentials from a non-JSON string result before offload', () => {
    const text = [
      'Service configuration dump',
      'password: hunter2',
      'clientSecret=abc123',
      'greeting: keep-me',
      'X'.repeat(2000),
    ].join('\n');

    const processed = ToolResultProcessor.process(
      'shell',
      {},
      text,
      undefined,
      undefined,
      { maxOutputSize: 200 }
    );

    expect(processed.outputTruncated).toBe(true);
    createdFiles.push(processed.outputFile!);

    const saved = fs.readFileSync(processed.outputFile!, 'utf8');
    expect(saved).not.toContain('hunter2');
    expect(saved).not.toContain('abc123');
    expect(saved).toContain(ToolResultProcessor.REDACTED);
    // A non-sensitive key/value pair is left alone.
    expect(saved).toContain('keep-me');
  });

  it('fails closed at the depth ceiling instead of returning an unwalked subtree', () => {
    const nest = (depth: number, inner: any) => {
      let node = inner;
      for (let index = 0; index < depth; index += 1) node = { nested: node };
      return node;
    };

    // Just inside the ceiling: the key is still inspected and redacted.
    const atBoundary = ToolResultProcessor.redactSensitive(nest(11, { password: 'deep-secret' }));
    expect(JSON.stringify(atBoundary)).not.toContain('deep-secret');

    // Beyond it: the subtree is replaced, so nothing uninspected is returned.
    const beyond = ToolResultProcessor.redactSensitive(nest(14, { password: 'deep-secret' }));
    const serialised = JSON.stringify(beyond);
    expect(serialised).not.toContain('deep-secret');
    expect(serialised).toContain('[DEPTH-LIMIT]');
  });
});