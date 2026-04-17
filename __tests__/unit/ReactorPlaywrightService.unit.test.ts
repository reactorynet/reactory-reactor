import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ── Playwright mock ───────────────────────────────────────────────────────────

const mockKeyboard = { press: jest.fn() };
const mockLocatorFirst = {
  evaluate: jest.fn(),
  innerHTML: jest.fn(),
  innerText: jest.fn(),
  isVisible: jest.fn(),
  boundingBox: jest.fn(),
};
const mockLocator = { first: jest.fn(() => mockLocatorFirst) };
const mockPage = {
  goto: jest.fn(),
  title: jest.fn(),
  url: jest.fn(),
  viewportSize: jest.fn(),
  click: jest.fn(),
  type: jest.fn(),
  fill: jest.fn(),
  selectOption: jest.fn(),
  keyboard: mockKeyboard,
  content: jest.fn(),
  innerText: jest.fn(),
  locator: jest.fn(() => mockLocator),
  waitForSelector: jest.fn(),
  evaluate: jest.fn(),
  screenshot: jest.fn(),
  pdf: jest.fn(),
};
const mockContext = {
  setDefaultTimeout: jest.fn(),
  newPage: jest.fn().mockResolvedValue(mockPage),
};
const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn(),
};

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-session-id') }));

jest.mock('@reactory/server-core/application/decorators/service', () => ({
  service: () => (cls: unknown) => cls,
}));

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockProps = {} as Reactory.Service.IReactoryServiceProps;
const mockServerContext = {} as Reactory.Server.IReactoryContext;

describe('ReactorPlaywrightService', () => {
  let service: InstanceType<typeof ReactorPlaywrightService>;
  let ReactorPlaywrightService: typeof import('../../services/playwright/ReactorPlaywrightService').default;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const mod = await import('../../services/playwright/ReactorPlaywrightService');
    ReactorPlaywrightService = mod.default;
    service = new ReactorPlaywrightService(mockProps, mockServerContext);
  });

  afterEach(async () => {
    // Cleanly shut down to clear the interval timer
    await service.onShutdown();
    jest.useRealTimers();
  });

  // ── Session Management ──────────────────────────────────────────────────────

  describe('createSession', () => {
    it('returns a sessionId', async () => {
      const { sessionId } = await service.createSession();
      expect(sessionId).toBe('test-session-id');
    });

    it('launches chromium with headless=true by default', async () => {
      const { chromium } = await import('playwright');
      await service.createSession();
      expect(chromium.launch).toHaveBeenCalledWith({ headless: true });
    });

    it('launches chromium with headless=false when specified', async () => {
      const { chromium } = await import('playwright');
      await service.createSession({ headless: false });
      expect(chromium.launch).toHaveBeenCalledWith({ headless: false });
    });

    it('passes viewport and userAgent to newContext', async () => {
      const viewport = { width: 1920, height: 1080 };
      await service.createSession({ viewport, userAgent: 'TestAgent/1.0' });
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ viewport, userAgent: 'TestAgent/1.0' }),
      );
    });

    it('sets default timeout on the context', async () => {
      await service.createSession({ timeout: 5000 });
      expect(mockContext.setDefaultTimeout).toHaveBeenCalledWith(5000);
    });

    it('registers the session so listSessions returns one entry', async () => {
      mockPage.url.mockReturnValue('about:blank');
      await service.createSession();
      const sessions = service.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('test-session-id');
    });
  });

  describe('closeSession', () => {
    it('closes the browser and removes the session', async () => {
      mockPage.url.mockReturnValue('about:blank');
      await service.createSession();
      await service.closeSession('test-session-id');
      expect(mockBrowser.close).toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it('is a no-op for an unknown session id (does not throw)', async () => {
      await expect(service.closeSession('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('returns an empty array when no sessions exist', () => {
      expect(service.listSessions()).toEqual([]);
    });

    it('returns SessionInfo including headless flag', async () => {
      mockPage.url.mockReturnValue('https://example.com');
      await service.createSession({ headless: false });
      const [info] = service.listSessions();
      expect(info.id).toBe('test-session-id');
      expect(info.headless).toBe(false);
      expect(info.url).toBe('https://example.com');
    });
  });

  // ── Navigation ───────────────────────────────────────────────────────────────

  describe('navigate', () => {
    beforeEach(async () => {
      await service.createSession();
    });

    it('calls page.goto with the correct url and waitUntil', async () => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.title.mockResolvedValue('Example');

      await service.navigate('test-session-id', { url: 'https://example.com', waitUntil: 'domcontentloaded' });
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    });

    it('returns url, title, and status from the response', async () => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.url.mockReturnValue('https://example.com/');
      mockPage.title.mockResolvedValue('Example Domain');

      const result = await service.navigate('test-session-id', { url: 'https://example.com/' });
      expect(result).toEqual({ url: 'https://example.com/', title: 'Example Domain', status: 200 });
    });

    it('handles a null response (e.g. about:blank navigation)', async () => {
      mockPage.goto.mockResolvedValue(null);
      mockPage.url.mockReturnValue('about:blank');
      mockPage.title.mockResolvedValue('');

      const result = await service.navigate('test-session-id', { url: 'about:blank' });
      expect(result.status).toBeNull();
    });

    it('throws when session does not exist', async () => {
      await expect(service.navigate('bad-id', { url: 'https://x.com' })).rejects.toThrow('Session not found');
    });
  });

  describe('getPageInfo', () => {
    it('returns url, title, and viewport', async () => {
      await service.createSession();
      mockPage.title.mockResolvedValue('Test Page');
      mockPage.url.mockReturnValue('https://test.com');
      mockPage.viewportSize.mockReturnValue({ width: 1280, height: 720 });

      const info = await service.getPageInfo('test-session-id');
      expect(info).toEqual({ url: 'https://test.com', title: 'Test Page', viewport: { width: 1280, height: 720 } });
    });
  });

  // ── Interaction ───────────────────────────────────────────────────────────────

  describe('click', () => {
    it('calls page.click with selector and options and returns success', async () => {
      await service.createSession();
      mockPage.click.mockResolvedValue(undefined);
      const result = await service.click('test-session-id', { selector: '#btn', button: 'left', clickCount: 2 });
      expect(mockPage.click).toHaveBeenCalledWith('#btn', { button: 'left', clickCount: 2, timeout: undefined });
      expect(result.success).toBe(true);
    });
  });

  describe('type', () => {
    it('calls page.type with the correct args', async () => {
      await service.createSession();
      mockPage.type.mockResolvedValue(undefined);
      await service.type('test-session-id', { selector: '#input', text: 'hello', delay: 50 });
      expect(mockPage.type).toHaveBeenCalledWith('#input', 'hello', { delay: 50 });
    });

    it('calls page.fill to clear the field when clear=true', async () => {
      await service.createSession();
      mockPage.fill.mockResolvedValue(undefined);
      mockPage.type.mockResolvedValue(undefined);
      await service.type('test-session-id', { selector: '#input', text: 'world', clear: true });
      expect(mockPage.fill).toHaveBeenCalledWith('#input', '');
    });
  });

  describe('select', () => {
    it('calls selectOption and returns selectedValues', async () => {
      await service.createSession();
      mockPage.selectOption.mockResolvedValue(['opt2']);
      const result = await service.select('test-session-id', '#sel', ['opt2']);
      expect(mockPage.selectOption).toHaveBeenCalledWith('#sel', ['opt2']);
      expect(result.selectedValues).toEqual(['opt2']);
    });
  });

  describe('pressKey', () => {
    it('calls keyboard.press with the key', async () => {
      await service.createSession();
      mockKeyboard.press.mockResolvedValue(undefined);
      await service.pressKey('test-session-id', 'Enter');
      expect(mockKeyboard.press).toHaveBeenCalledWith('Enter');
    });
  });

  // ── Content & Inspection ──────────────────────────────────────────────────────

  describe('getContent', () => {
    beforeEach(async () => {
      await service.createSession();
    });

    it('returns full page html and text when no selector', async () => {
      mockPage.content.mockResolvedValue('<html><body>hello</body></html>');
      mockPage.innerText.mockResolvedValue('hello');
      const result = await service.getContent('test-session-id');
      expect(result.html).toBe('<html><body>hello</body></html>');
      expect(result.text).toBe('hello');
      expect(mockPage.content).toHaveBeenCalled();
      expect(mockPage.innerText).toHaveBeenCalledWith('body');
    });

    it('returns scoped html and text when a selector is provided', async () => {
      mockLocatorFirst.innerHTML.mockResolvedValue('<p>scoped</p>');
      mockLocatorFirst.innerText.mockResolvedValue('scoped');
      const result = await service.getContent('test-session-id', '.container');
      expect(mockPage.locator).toHaveBeenCalledWith('.container');
      expect(result.html).toBe('<p>scoped</p>');
      expect(result.text).toBe('scoped');
    });
  });

  describe('inspectElement', () => {
    it('returns all inspection fields', async () => {
      await service.createSession();
      mockLocatorFirst.evaluate
        .mockResolvedValueOnce('<div id="x">content</div>') // outerHTML
        .mockResolvedValueOnce('div')                        // tagName
        .mockResolvedValueOnce({ id: 'x' })                 // attributes
        .mockResolvedValueOnce(3);                           // childCount
      mockLocatorFirst.innerText.mockResolvedValue('content');
      mockLocatorFirst.isVisible.mockResolvedValue(true);
      mockLocatorFirst.boundingBox.mockResolvedValue({ x: 10, y: 20, width: 100, height: 50 });

      const result = await service.inspectElement('test-session-id', '#x');
      expect(result.tagName).toBe('div');
      expect(result.visible).toBe(true);
      expect(result.childCount).toBe(3);
      expect(result.attributes).toEqual({ id: 'x' });
      expect(result.boundingBox).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    });
  });

  describe('waitForSelector', () => {
    it('returns { found: true } when the selector appears', async () => {
      await service.createSession();
      mockPage.waitForSelector.mockResolvedValue({});
      const result = await service.waitForSelector('test-session-id', { selector: '#el' });
      expect(result.found).toBe(true);
    });

    it('returns { found: false } on timeout without throwing', async () => {
      await service.createSession();
      mockPage.waitForSelector.mockRejectedValue(new Error('timeout'));
      const result = await service.waitForSelector('test-session-id', { selector: '#el' });
      expect(result.found).toBe(false);
    });
  });

  // ── JavaScript Evaluation ─────────────────────────────────────────────────────

  describe('evaluate', () => {
    it('calls page.evaluate with the script and returns the result', async () => {
      await service.createSession();
      mockPage.evaluate.mockResolvedValue({ count: 5 });
      const result = await service.evaluate('test-session-id', { script: 'return document.querySelectorAll("a").length' });
      expect(mockPage.evaluate).toHaveBeenCalledWith('return document.querySelectorAll("a").length');
      expect(result.result).toEqual({ count: 5 });
    });
  });

  // ── Capture ───────────────────────────────────────────────────────────────────

  describe('screenshot', () => {
    it('returns base64-encoded screenshot', async () => {
      await service.createSession();
      const buf = Buffer.from('fake-image');
      mockPage.screenshot.mockResolvedValue(buf);
      const result = await service.screenshot('test-session-id');
      expect(result.base64).toBe(buf.toString('base64'));
    });

    it('passes fullPage, type, and quality options', async () => {
      await service.createSession();
      mockPage.screenshot.mockResolvedValue(Buffer.from(''));
      await service.screenshot('test-session-id', { fullPage: true, type: 'jpeg', quality: 80 });
      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true, type: 'jpeg', quality: 80 }),
      );
    });
  });

  describe('pdf', () => {
    it('returns base64-encoded pdf', async () => {
      await service.createSession();
      const buf = Buffer.from('fake-pdf');
      mockPage.pdf.mockResolvedValue(buf);
      const result = await service.pdf('test-session-id');
      expect(result.base64).toBe(buf.toString('base64'));
    });

    it('passes path option when provided', async () => {
      await service.createSession();
      mockPage.pdf.mockResolvedValue(Buffer.from(''));
      await service.pdf('test-session-id', { path: '/tmp/out.pdf' });
      expect(mockPage.pdf).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/out.pdf' }));
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  describe('onShutdown', () => {
    it('closes all open sessions', async () => {
      mockPage.url.mockReturnValue('about:blank');
      await service.createSession();
      await service.onShutdown();
      expect(mockBrowser.close).toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it('clears the cleanup timer', async () => {
      await service.onShutdown();
      // calling onShutdown a second time should not throw
      await expect(service.onShutdown()).resolves.toBeUndefined();
    });
  });
});
