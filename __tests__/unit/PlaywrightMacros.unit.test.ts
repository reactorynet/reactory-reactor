import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChatState } from '../../ai/openai/types/chat';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockPlaywrightSvc = {
  createSession: jest.fn(),
  closeSession: jest.fn(),
  navigate: jest.fn(),
  click: jest.fn(),
  type: jest.fn(),
  select: jest.fn(),
  pressKey: jest.fn(),
  getContent: jest.fn(),
  inspectElement: jest.fn(),
  waitForSelector: jest.fn(),
  evaluate: jest.fn(),
  screenshot: jest.fn(),
  pdf: jest.fn(),
  getPageInfo: jest.fn(),
  listSessions: jest.fn(),
};

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    context: {
      getService: jest.fn((fqn: string) => {
        if (fqn === 'reactor.ReactorPlaywrightService@1.0.0') return mockPlaywrightSvc;
        return undefined;
      }),
    } as unknown as Reactory.Server.IReactoryContext,
    user: { id: 'user-123' } as unknown as Reactory.Models.IUserDocument,
    vars: {},
    ...overrides,
  } as ChatState;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Playwright Macros', () => {
  let macros: typeof import('../../ai/macro/playwright/macro');

  beforeEach(async () => {
    jest.clearAllMocks();
    macros = await import('../../ai/macro/playwright/macro');
  });

  // ── PlaywrightMacros registry ─────────────────────────────────────────────

  describe('PlaywrightMacros registry', () => {
    it('exports an array of 15 MacroComponentDefinitions', () => {
      const { PlaywrightMacros } = macros;
      expect(PlaywrightMacros).toHaveLength(15);
    });

    it('read-only macros have safeForAutoExecution=true', () => {
      const { PlaywrightMacros } = macros;
      const readOnly = ['playwright_get_content', 'playwright_inspect', 'playwright_wait_for',
        'playwright_screenshot', 'playwright_pdf', 'playwright_page_info', 'playwright_list_sessions'];
      for (const reg of PlaywrightMacros) {
        const tool = reg.tools?.[0];
        if (readOnly.includes(tool?.function?.name ?? '')) {
          expect(tool?.safeForAutoExecution).toBe(true);
        }
      }
    });

    it('write macros do not have safeForAutoExecution=true', () => {
      const { PlaywrightMacros } = macros;
      const write = ['playwright_open_session', 'playwright_navigate', 'playwright_click',
        'playwright_type', 'playwright_select', 'playwright_press_key', 'playwright_evaluate',
        'playwright_close_session'];
      for (const reg of PlaywrightMacros) {
        const tool = reg.tools?.[0];
        if (write.includes(tool?.function?.name ?? '')) {
          expect(tool?.safeForAutoExecution).not.toBe(true);
        }
      }
    });
  });

  // ── PlaywrightOpenSession ─────────────────────────────────────────────────

  describe('PlaywrightOpenSession', () => {
    it('creates a session and stores sessionId in state.vars', async () => {
      mockPlaywrightSvc.createSession.mockResolvedValue({ sessionId: 'sess-abc' });
      const state = makeState();
      const result = await macros.PlaywrightOpenSession({}, state);
      expect(result.success).toBe(true);
      expect(state.vars!.playwrightSessionId).toBe('sess-abc');
      expect(result.data).toMatchObject({ sessionId: 'sess-abc' });
    });

    it('passes headless=false when prop is "false"', async () => {
      mockPlaywrightSvc.createSession.mockResolvedValue({ sessionId: 'sess-1' });
      await macros.PlaywrightOpenSession({ headless: 'false' }, makeState());
      expect(mockPlaywrightSvc.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ headless: false }),
      );
    });

    it('parses viewport string "1920x1080" correctly', async () => {
      mockPlaywrightSvc.createSession.mockResolvedValue({ sessionId: 'sess-2' });
      await macros.PlaywrightOpenSession({ viewport: '1920x1080' }, makeState());
      expect(mockPlaywrightSvc.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ viewport: { width: 1920, height: 1080 } }),
      );
    });

    it('returns an error result when the service throws', async () => {
      mockPlaywrightSvc.createSession.mockRejectedValue(new Error('browser launch failed'));
      const result = await macros.PlaywrightOpenSession({}, makeState());
      expect(result.success).toBe(false);
      expect(result.error).toContain('browser launch failed');
    });

    it('returns an error when service is unavailable', async () => {
      const state = makeState({ context: { getService: jest.fn(() => undefined) } as unknown as Reactory.Server.IReactoryContext });
      const result = await macros.PlaywrightOpenSession({}, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('instructions mention the sessionId', async () => {
      mockPlaywrightSvc.createSession.mockResolvedValue({ sessionId: 'sess-xyz' });
      const result = await macros.PlaywrightOpenSession({}, makeState());
      expect(result.instructions).toContain('sess-xyz');
    });
  });

  // ── PlaywrightCloseSession ────────────────────────────────────────────────

  describe('PlaywrightCloseSession', () => {
    it('closes the session and removes sessionId from state.vars', async () => {
      mockPlaywrightSvc.closeSession.mockResolvedValue(undefined);
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightCloseSession({ sessionId: 'sess-1' }, state);
      expect(result.success).toBe(true);
      expect(state.vars!.playwrightSessionId).toBeUndefined();
    });

    it('does not delete state.vars.playwrightSessionId when a different session is closed', async () => {
      mockPlaywrightSvc.closeSession.mockResolvedValue(undefined);
      const state = makeState({ vars: { playwrightSessionId: 'sess-active' } });
      await macros.PlaywrightCloseSession({ sessionId: 'sess-other' }, state);
      expect(state.vars!.playwrightSessionId).toBe('sess-active');
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.closeSession.mockRejectedValue(new Error('close failed'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightCloseSession({}, state);
      expect(result.success).toBe(false);
    });

    it('returns error when no sessionId available', async () => {
      const state = makeState({ vars: {} });
      const result = await macros.PlaywrightCloseSession({}, state);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no session/i);
    });
  });

  // ── PlaywrightNavigate ────────────────────────────────────────────────────

  describe('PlaywrightNavigate', () => {
    it('returns an error when url is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightNavigate({ url: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('URL is required');
    });

    it('navigates and stores currentUrl in state.vars', async () => {
      mockPlaywrightSvc.navigate.mockResolvedValue({ url: 'https://example.com', title: 'Example', status: 200 });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      await macros.PlaywrightNavigate({ url: 'https://example.com' }, state);
      expect(state.vars!.playwrightCurrentUrl).toBe('https://example.com');
    });

    it('returns success with url, title, and status', async () => {
      mockPlaywrightSvc.navigate.mockResolvedValue({ url: 'https://example.com', title: 'Example', status: 200 });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightNavigate({ url: 'https://example.com' }, state);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ url: 'https://example.com', title: 'Example', status: 200 });
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.navigate.mockRejectedValue(new Error('nav failed'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightNavigate({ url: 'https://x.com' }, state);
      expect(result.success).toBe(false);
    });
  });

  // ── PlaywrightClick ───────────────────────────────────────────────────────

  describe('PlaywrightClick', () => {
    it('returns error when selector is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightClick({ selector: '' }, state);
      expect(result.success).toBe(false);
      expect(result.error).toContain('selector is required');
    });

    it('calls service.click with parsed options and returns success', async () => {
      mockPlaywrightSvc.click.mockResolvedValue({ success: true });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightClick({ selector: '#btn', button: 'right', clickCount: '2' }, state);
      expect(mockPlaywrightSvc.click).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        selector: '#btn', button: 'right', clickCount: 2,
      }));
      expect(result.success).toBe(true);
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.click.mockRejectedValue(new Error('element not found'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightClick({ selector: '#gone' }, state);
      expect(result.success).toBe(false);
    });
  });

  // ── PlaywrightType ────────────────────────────────────────────────────────

  describe('PlaywrightType', () => {
    it('returns error when selector or text is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const r1 = await macros.PlaywrightType({ selector: '', text: 'hi' }, state);
      expect(r1.success).toBe(false);
      const r2 = await macros.PlaywrightType({ selector: '#i', text: '' }, state);
      expect(r2.success).toBe(false);
    });

    it('passes clear=true and parses delay as integer', async () => {
      mockPlaywrightSvc.type.mockResolvedValue({ success: true });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      await macros.PlaywrightType({ selector: '#i', text: 'abc', delay: '100', clear: 'true' }, state);
      expect(mockPlaywrightSvc.type).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        clear: true, delay: 100,
      }));
    });
  });

  // ── PlaywrightSelect ──────────────────────────────────────────────────────

  describe('PlaywrightSelect', () => {
    it('returns error when selector or values is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const r = await macros.PlaywrightSelect({ selector: '', values: 'a' }, state);
      expect(r.success).toBe(false);
    });

    it('splits comma-separated values and returns selectedValues', async () => {
      mockPlaywrightSvc.select.mockResolvedValue({ selectedValues: ['b', 'c'] });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightSelect({ selector: '#sel', values: 'b, c' }, state);
      expect(mockPlaywrightSvc.select).toHaveBeenCalledWith('sess-1', '#sel', ['b', 'c']);
      expect(result.success).toBe(true);
    });
  });

  // ── PlaywrightPressKey ────────────────────────────────────────────────────

  describe('PlaywrightPressKey', () => {
    it('returns error when key is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPressKey({ key: '' }, state);
      expect(result.success).toBe(false);
    });

    it('calls service.pressKey and returns success', async () => {
      mockPlaywrightSvc.pressKey.mockResolvedValue({ success: true });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPressKey({ key: 'Enter' }, state);
      expect(mockPlaywrightSvc.pressKey).toHaveBeenCalledWith('sess-1', 'Enter');
      expect(result.success).toBe(true);
    });
  });

  // ── PlaywrightGetContent ──────────────────────────────────────────────────

  describe('PlaywrightGetContent', () => {
    it('calls service.getContent without selector', async () => {
      mockPlaywrightSvc.getContent.mockResolvedValue({ html: '<p>hi</p>', text: 'hi' });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightGetContent({}, state);
      expect(mockPlaywrightSvc.getContent).toHaveBeenCalledWith('sess-1', undefined);
      expect(result.success).toBe(true);
    });

    it('calls service.getContent with selector when provided', async () => {
      mockPlaywrightSvc.getContent.mockResolvedValue({ html: '<span>x</span>', text: 'x' });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      await macros.PlaywrightGetContent({ selector: '.item' }, state);
      expect(mockPlaywrightSvc.getContent).toHaveBeenCalledWith('sess-1', '.item');
    });

    it('truncates html and text over 10,000 chars', async () => {
      const big = 'x'.repeat(15000);
      mockPlaywrightSvc.getContent.mockResolvedValue({ html: big, text: big });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightGetContent({}, state);
      const data = result.data as { html: string; text: string; fullLength: { html: number; text: number } };
      expect(data.html.length).toBeLessThanOrEqual(10_020); // 10,000 + "[truncated]" suffix
      expect(data.text.length).toBeLessThanOrEqual(10_020);
      expect(data.fullLength.html).toBe(15000);
    });
  });

  // ── PlaywrightInspectElement ──────────────────────────────────────────────

  describe('PlaywrightInspectElement', () => {
    it('returns error when selector is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightInspectElement({ selector: '' }, state);
      expect(result.success).toBe(false);
    });

    it('returns inspection data from service', async () => {
      mockPlaywrightSvc.inspectElement.mockResolvedValue({
        tagName: 'button', attributes: { class: 'btn' }, visible: true,
        boundingBox: { x: 0, y: 0, width: 80, height: 32 }, text: 'Click me',
        html: '<button class="btn">Click me</button>', childCount: 0,
      });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightInspectElement({ selector: '.btn' }, state);
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.tagName).toBe('button');
      expect(data.visible).toBe(true);
    });
  });

  // ── PlaywrightWaitFor ─────────────────────────────────────────────────────

  describe('PlaywrightWaitFor', () => {
    it('returns error when selector is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightWaitFor({ selector: '' }, state);
      expect(result.success).toBe(false);
    });

    it('returns found=true when element is found', async () => {
      mockPlaywrightSvc.waitForSelector.mockResolvedValue({ found: true });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightWaitFor({ selector: '#el' }, state);
      expect(result.success).toBe(true);
      const data = result.data as { found: boolean };
      expect(data.found).toBe(true);
    });

    it('returns found=false when element is not found', async () => {
      mockPlaywrightSvc.waitForSelector.mockResolvedValue({ found: false });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightWaitFor({ selector: '#missing' }, state);
      expect(result.success).toBe(true);
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    });
  });

  // ── PlaywrightEvaluate ────────────────────────────────────────────────────

  describe('PlaywrightEvaluate', () => {
    it('returns error when script is missing', async () => {
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightEvaluate({ script: '' }, state);
      expect(result.success).toBe(false);
    });

    it('returns serialized result from page evaluation', async () => {
      mockPlaywrightSvc.evaluate.mockResolvedValue({ result: { count: 3 } });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightEvaluate({ script: 'document.links.length' }, state);
      expect(result.success).toBe(true);
      const data = result.data as { result: unknown };
      expect(data.result).toEqual({ count: 3 });
    });

    it('handles non-JSON-serializable result by coercing to string', async () => {
      // Circular reference cannot be JSON-serialized
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      mockPlaywrightSvc.evaluate.mockResolvedValue({ result: circular });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightEvaluate({ script: 'whatever' }, state);
      expect(result.success).toBe(true);
      const data = result.data as { result: unknown };
      expect(typeof data.result).toBe('string');
    });
  });

  // ── PlaywrightScreenshot ──────────────────────────────────────────────────

  describe('PlaywrightScreenshot', () => {
    it('returns url, path and sizeKb', async () => {
      const b64 = Buffer.from('fake-image-data').toString('base64');
      mockPlaywrightSvc.screenshot.mockResolvedValue({ base64: b64 });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightScreenshot({}, state);
      expect(result.success).toBe(true);
      const data = result.data as { url: string; path: string; sizeKb: number };
      expect(data.url).toContain('/cdn/profiles/reactor/personas/');
      expect(data.path).toContain('workspace');
      expect(typeof data.sizeKb).toBe('number');
    });

    it('passes fullPage=true when prop is "true"', async () => {
      mockPlaywrightSvc.screenshot.mockResolvedValue({ base64: '' });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      await macros.PlaywrightScreenshot({ fullPage: 'true' }, state);
      expect(mockPlaywrightSvc.screenshot).toHaveBeenCalledWith('sess-1', expect.objectContaining({ fullPage: true }));
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.screenshot.mockRejectedValue(new Error('screenshot failed'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightScreenshot({}, state);
      expect(result.success).toBe(false);
    });
  });

  // ── PlaywrightPdf ─────────────────────────────────────────────────────────

  describe('PlaywrightPdf', () => {
    it('returns url, path and sizeKb', async () => {
      const b64 = Buffer.from('fake-pdf-data').toString('base64');
      mockPlaywrightSvc.pdf.mockResolvedValue({ base64: b64 });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPdf({}, state);
      expect(result.success).toBe(true);
      const data = result.data as { url: string; path: string; sizeKb: number };
      expect(data.url).toContain('/cdn/profiles/reactor/personas/');
      expect(data.path).toContain('workspace');
      expect(typeof data.sizeKb).toBe('number');
    });

    it('passes path option when provided', async () => {
      mockPlaywrightSvc.pdf.mockResolvedValue({ base64: '', path: '/tmp/out.pdf' });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      await macros.PlaywrightPdf({ path: '/tmp/out.pdf' }, state);
      expect(mockPlaywrightSvc.pdf).toHaveBeenCalledWith('sess-1', expect.objectContaining({ path: '/tmp/out.pdf' }));
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.pdf.mockRejectedValue(new Error('pdf only works headless'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPdf({}, state);
      expect(result.success).toBe(false);
    });
  });

  // ── PlaywrightPageInfo ────────────────────────────────────────────────────

  describe('PlaywrightPageInfo', () => {
    it('returns url, title, viewport from service', async () => {
      mockPlaywrightSvc.getPageInfo.mockResolvedValue({ url: 'https://a.com', title: 'A', viewport: { width: 1280, height: 720 } });
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPageInfo({}, state);
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.url).toBe('https://a.com');
      expect(data.title).toBe('A');
    });

    it('returns error result when service throws', async () => {
      mockPlaywrightSvc.getPageInfo.mockRejectedValue(new Error('session gone'));
      const state = makeState({ vars: { playwrightSessionId: 'sess-1' } });
      const result = await macros.PlaywrightPageInfo({}, state);
      expect(result.success).toBe(false);
    });
  });

  // ── PlaywrightListSessions ────────────────────────────────────────────────

  describe('PlaywrightListSessions', () => {
    it('returns empty sessions list when no sessions active', async () => {
      mockPlaywrightSvc.listSessions.mockReturnValue([]);
      const state = makeState({ vars: {} });
      const result = await macros.PlaywrightListSessions({}, state);
      expect(result.success).toBe(true);
      const data = result.data as { sessions: unknown[]; count: number };
      expect(data.count).toBe(0);
    });

    it('returns sessions with count', async () => {
      const now = new Date();
      mockPlaywrightSvc.listSessions.mockReturnValue([
        { id: 's1', url: 'https://x.com', headless: true, createdAt: now, lastActivity: now },
      ]);
      const state = makeState({ vars: {} });
      const result = await macros.PlaywrightListSessions({}, state);
      const data = result.data as { sessions: unknown[]; count: number };
      expect(data.count).toBe(1);
    });

    it('instructions mention "No active sessions" when empty', async () => {
      mockPlaywrightSvc.listSessions.mockReturnValue([]);
      const state = makeState({ vars: {} });
      const result = await macros.PlaywrightListSessions({}, state);
      expect(result.instructions).toContain('No active sessions');
    });
  });
});
