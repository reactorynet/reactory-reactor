import ReactorProviderService from '../ReactorProviderService';
import { encryptCredentials, decryptCredentials } from '../../../utils/credential-encryption';

const AUTH_KEY_PREFIX = 'ai-provider:';

const makeUser = (authentications: any[] = []) => {
  const user: any = {
    authentications,
    setAuthentication: jest.fn(async function (this: any, auth: any) {
      const existing = this.authentications.find((a: any) => a.provider === auth.provider);
      if (existing) {
        existing.props = { ...(existing.props.toObject ? existing.props.toObject() : existing.props), ...auth.props };
        if (auth.lastLogin) existing.lastLogin = auth.lastLogin;
      } else {
        this.authentications.push({ _id: `id-${auth.provider}`, ...auth });
      }
      await this.save();
      return true;
    }),
    removeAuthentication: jest.fn(async function (this: any, provider: string) {
      const found = this.authentications.find((a: any) => a.provider === provider);
      if (found) {
        this.authentications = this.authentications.filter((a: any) => a.provider !== provider);
        await this.save();
        return true;
      }
      return false;
    }),
    save: jest.fn(async function () { return this; }),
  };
  return user;
};

const makeAuth = (providerId: string, props: Record<string, any>) => ({
  _id: `id-${providerId}`,
  provider: `${AUTH_KEY_PREFIX}${providerId}`,
  props,
  lastLogin: new Date(),
});

const makeContext = (overrides: Partial<Reactory.Server.IReactoryContext> & { user?: any; partner?: any; hasRole?: (r: string) => boolean } = {}) => {
  return {
    user: overrides.user ?? makeUser(),
    partner: overrides.partner ?? { auth_config: [], save: jest.fn(async () => true) },
    hasRole: overrides.hasRole ?? ((_r: string) => false),
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    getService: jest.fn(),
  } as unknown as Reactory.Server.IReactoryContext;
};

describe('ReactorProviderService auth', () => {
  let originalCredentialKey: string | undefined;

  beforeAll(() => {
    originalCredentialKey = process.env.REACTORY_CREDENTIAL_KEY;
    process.env.REACTORY_CREDENTIAL_KEY = 'test-credential-key-0123456789-test';
  });

  afterAll(() => {
    if (originalCredentialKey === undefined) {
      delete process.env.REACTORY_CREDENTIAL_KEY;
    } else {
      process.env.REACTORY_CREDENTIAL_KEY = originalCredentialKey;
    }
  });

  describe('saveProviderAuth + resolveProviderCredentials roundtrip', () => {
    it('encrypts credentials on save and decrypts on resolve (source: user)', async () => {
      const user = makeUser();
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      const plaintext = { apiKey: 'sk-test-1234567890', endpoint: 'https://api.test', organization: 'org-1' };
      await service.saveProviderAuth({ providerId: 'openai', credentials: plaintext, setAsAccountDefault: true });

      // Stored props on the user must be encrypted (apiKey prefixed with 'enc:')
      const stored = user.authentications.find((a: any) => a.provider === `${AUTH_KEY_PREFIX}openai`);
      expect(stored).toBeDefined();
      const storedApiKey = stored.props.toObject ? stored.props.toObject().apiKey : stored.props.apiKey;
      expect(storedApiKey).toMatch(/^enc:/);
      expect(storedApiKey).not.toContain('sk-test-1234567890');

      const resolved = await service.resolveProviderCredentials('openai');
      expect(resolved.source).toBe('user');
      expect(resolved.apiKey).toBe('sk-test-1234567890');
      expect(resolved.endpoint).toBe('https://api.test');
      expect(resolved.organization).toBe('org-1');
    });
  });

  describe('setAsAccountDefault clears isDefault on other providers', () => {
    it('clears isDefault on every other ai-provider:* auth the user holds', async () => {
      const user = makeUser([
        makeAuth('anthropic', { apiKey: 'sk-ant-1', isDefault: true }),
      ]);
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-openai-1' },
        setAsAccountDefault: true,
      });

      const anthropicAuth = user.authentications.find((a: any) => a.provider === `${AUTH_KEY_PREFIX}anthropic`);
      const anthropicProps = anthropicAuth.props.toObject ? anthropicAuth.props.toObject() : anthropicAuth.props;
      expect(anthropicProps.isDefault).toBe(false);

      const openaiAuth = user.authentications.find((a: any) => a.provider === `${AUTH_KEY_PREFIX}openai`);
      const openaiProps = openaiAuth.props.toObject ? openaiAuth.props.toObject() : openaiAuth.props;
      expect(openaiProps.isDefault).toBe(true);
    });
  });

  describe('setAsAppDefault ADMIN enforcement', () => {
    it('throws when a non-ADMIN user sets setAsAppDefault', async () => {
      const context = makeContext({ hasRole: () => false });
      const service = new ReactorProviderService({} as any, context);

      await expect(
        service.saveProviderAuth({
          providerId: 'openai',
          credentials: { apiKey: 'sk-x' },
          setAsAppDefault: true,
        })
      ).rejects.toThrow(/ADMIN/);
    });

    it('updates partner.auth_config when an ADMIN sets setAsAppDefault', async () => {
      const partner: any = { auth_config: [], save: jest.fn(async () => true) };
      const context = makeContext({ partner, hasRole: (r: string) => r === 'ADMIN' });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-x' },
        setAsAppDefault: true,
      });

      expect(partner.auth_config.length).toBe(1);
      expect(partner.auth_config[0].provider).toBe(`${AUTH_KEY_PREFIX}openai`);
      expect(partner.auth_config[0].enabled).toBe(true);
      expect(partner.save).toHaveBeenCalled();
    });
  });

  describe('getUserProviderAuth maskedKeyHint is masked, not raw', () => {
    it('returns a masked hint that does not contain the raw key', async () => {
      const user = makeUser();
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-abcdefghij1234567890' },
      });

      const statuses = await service.getUserProviderAuth();
      const openai = statuses.find((s) => s.provider === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.configured).toBe(true);
      expect(openai!.maskedKeyHint).toBeDefined();
      expect(openai!.maskedKeyHint).not.toContain('abcdefghij1234567890');
      expect(openai!.maskedKeyHint).toMatch(/…/);
    });
  });

  describe('sessionOverride priority', () => {
    it('sessionOverride wins over user-stored credentials', async () => {
      const user = makeUser();
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-user-key', endpoint: 'https://user.api' },
      });

      const resolved = await service.resolveProviderCredentials('openai', undefined, {
        apiKey: 'sk-session-key',
        endpoint: 'https://session.api',
      });

      expect(resolved.source).toBe('session');
      expect(resolved.apiKey).toBe('sk-session-key');
      expect(resolved.endpoint).toBe('https://session.api');
    });

    it('falls back to user auth when sessionOverride has no credential values', async () => {
      const user = makeUser();
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-user-key' },
      });

      const resolved = await service.resolveProviderCredentials('openai', undefined, {
        apiKey: undefined,
        endpoint: '',
        organization: null,
      });

      expect(resolved.source).toBe('user');
      expect(resolved.apiKey).toBe('sk-user-key');
    });
  });

  describe('removeProviderAuth', () => {
    it('removes the user authentication entry', async () => {
      const user = makeUser();
      const context = makeContext({ user });
      const service = new ReactorProviderService({} as any, context);

      await service.saveProviderAuth({
        providerId: 'openai',
        credentials: { apiKey: 'sk-x' },
      });
      expect(user.authentications.length).toBe(1);

      const result = await service.removeProviderAuth('openai');
      expect(result).toBe(true);
      expect(user.authentications.length).toBe(0);
    });
  });

  describe('encryption utility parity', () => {
    it('decryptCredentials reverses encryptCredentials', () => {
      const plaintext = { apiKey: 'sk-roundtrip', organization: 'org-x' };
      const encrypted = encryptCredentials(plaintext);
      expect(encrypted.apiKey).toMatch(/^enc:/);
      const decrypted = decryptCredentials(encrypted);
      expect(decrypted.apiKey).toBe('sk-roundtrip');
      expect(decrypted.organization).toBe('org-x');
    });
  });
});
