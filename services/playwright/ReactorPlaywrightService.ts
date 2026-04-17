import { chromium, Browser } from 'playwright';
import { v4 as uuid } from 'uuid';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import {
  PlaywrightSession,
  SessionOptions,
  NavigateOptions,
  NavigateResult,
  ClickOptions,
  TypeOptions,
  ScreenshotOptions,
  EvaluateOptions,
  WaitOptions,
  DOMInspectResult,
  SessionInfo,
  PageInfo,
} from './types';

const DEFAULT_TIMEOUT = 30_000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

@service({
  id: 'reactor.ReactorPlaywrightService@1.0.0',
  nameSpace: 'reactor',
  name: 'ReactorPlaywrightService',
  version: '1.0.0',
  description: 'Manages Playwright browser sessions for automated web interaction, DOM inspection, and content capture',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
export default class ReactorPlaywrightService {
  nameSpace = 'reactor';
  name = 'ReactorPlaywrightService';
  version = '1.0.0';

  props: Reactory.Service.IReactoryServiceProps;
  context: Reactory.Server.IReactoryContext;

  private sessions: Map<string, PlaywrightSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.props = props;
    this.context = context;
    this.startCleanupTimer();
  }

  // ── Lifecycle ────────────────────────────────────────────

  async onShutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
    logger.info('ReactorPlaywrightService: all sessions closed on shutdown');
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanIdleSessions().catch((err) =>
        logger.warn('ReactorPlaywrightService: idle cleanup error', err),
      );
    }, CLEANUP_INTERVAL_MS);
  }

  private async cleanIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_IDLE_TIMEOUT_MS) {
        logger.info(`ReactorPlaywrightService: closing idle session ${id}`);
        await this.closeSession(id);
      }
    }
  }

  // ── Session management ───────────────────────────────────

  private getSession(sessionId: string): PlaywrightSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.lastActivity = new Date();
    return session;
  }

  async createSession(options: SessionOptions = {}): Promise<{ sessionId: string }> {
    const {
      headless = true,
      viewport = { width: 1280, height: 720 },
      userAgent,
      timeout = DEFAULT_TIMEOUT,
    } = options;

    const browser: Browser = await chromium.launch({ headless });
    const contextOptions: Record<string, unknown> = { viewport };
    if (userAgent) contextOptions.userAgent = userAgent;

    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(timeout);

    const page = await context.newPage();
    const sessionId = uuid();
    const now = new Date();

    this.sessions.set(sessionId, {
      id: sessionId,
      browser,
      context,
      page,
      createdAt: now,
      lastActivity: now,
      headless,
    });

    logger.info(`ReactorPlaywrightService: session created ${sessionId} (headless=${headless})`);
    return { sessionId };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await session.browser.close();
    } catch (err) {
      logger.warn(`ReactorPlaywrightService: error closing browser for session ${sessionId}`, err);
    }
    this.sessions.delete(sessionId);
    logger.info(`ReactorPlaywrightService: session closed ${sessionId}`);
  }

  listSessions(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      infos.push({
        id: s.id,
        url: s.page.url(),
        title: '',
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        headless: s.headless,
      });
    }
    return infos;
  }

  // ── Navigation ───────────────────────────────────────────

  async navigate(sessionId: string, options: NavigateOptions): Promise<NavigateResult> {
    const session = this.getSession(sessionId);
    const { url, waitUntil = 'load' } = options;

    const response = await session.page.goto(url, { waitUntil });
    const title = await session.page.title();

    return {
      url: session.page.url(),
      title,
      status: response ? response.status() : null,
    };
  }

  async getPageInfo(sessionId: string): Promise<PageInfo> {
    const session = this.getSession(sessionId);
    const title = await session.page.title();
    const viewport = session.page.viewportSize();
    return {
      url: session.page.url(),
      title,
      viewport,
    };
  }

  // ── Interaction ──────────────────────────────────────────

  async click(sessionId: string, options: ClickOptions): Promise<{ success: boolean }> {
    const session = this.getSession(sessionId);
    const { selector, button = 'left', clickCount = 1, timeout } = options;
    await session.page.click(selector, { button, clickCount, timeout });
    return { success: true };
  }

  async type(sessionId: string, options: TypeOptions): Promise<{ success: boolean }> {
    const session = this.getSession(sessionId);
    const { selector, text, delay = 0, clear = false } = options;

    if (clear) {
      await session.page.fill(selector, '');
    }

    await session.page.type(selector, text, { delay });
    return { success: true };
  }

  async select(
    sessionId: string,
    selector: string,
    values: string[],
  ): Promise<{ selectedValues: string[] }> {
    const session = this.getSession(sessionId);
    const selected = await session.page.selectOption(selector, values);
    return { selectedValues: selected };
  }

  async pressKey(sessionId: string, key: string): Promise<{ success: boolean }> {
    const session = this.getSession(sessionId);
    await session.page.keyboard.press(key);
    return { success: true };
  }

  // ── Content & Inspection ─────────────────────────────────

  async getContent(
    sessionId: string,
    selector?: string,
  ): Promise<{ html: string; text: string }> {
    const session = this.getSession(sessionId);

    if (selector) {
      const el = session.page.locator(selector).first();
      const html = await el.innerHTML();
      const text = await el.innerText();
      return { html, text };
    }

    const html = await session.page.content();
    const text = await session.page.innerText('body');
    return { html, text };
  }

  async inspectElement(sessionId: string, selector: string): Promise<DOMInspectResult> {
    const session = this.getSession(sessionId);
    const el = session.page.locator(selector).first();

    const [html, text, tagName, attributes, childCount, visible, boundingBox] =
      await Promise.all([
        el.evaluate((node) => node.outerHTML),
        el.innerText().catch(() => ''),
        el.evaluate((node) => node.tagName.toLowerCase()),
        el.evaluate((node) => {
          const attrs: Record<string, string> = {};
          for (const attr of node.attributes) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        }),
        el.evaluate((node) => node.children.length),
        el.isVisible(),
        el.boundingBox(),
      ]);

    return { html, text, tagName, attributes, childCount, visible, boundingBox };
  }

  async waitForSelector(
    sessionId: string,
    options: WaitOptions,
  ): Promise<{ found: boolean }> {
    const session = this.getSession(sessionId);
    const { selector, state = 'visible', timeout } = options;
    try {
      await session.page.waitForSelector(selector, { state, timeout });
      return { found: true };
    } catch {
      return { found: false };
    }
  }

  // ── JavaScript evaluation ────────────────────────────────

  async evaluate(sessionId: string, options: EvaluateOptions): Promise<{ result: unknown }> {
    const session = this.getSession(sessionId);
    const result = await session.page.evaluate(options.script);
    return { result };
  }

  // ── Capture ──────────────────────────────────────────────

  async screenshot(
    sessionId: string,
    options: ScreenshotOptions = {},
  ): Promise<{ base64: string; path?: string }> {
    const session = this.getSession(sessionId);
    const { fullPage = false, path, type = 'png', quality } = options;

    const screenshotOptions: Record<string, unknown> = { fullPage, type };
    if (path) screenshotOptions.path = path;
    if (type === 'jpeg' && quality !== undefined) screenshotOptions.quality = quality;

    const buffer = await session.page.screenshot(screenshotOptions);
    return {
      base64: buffer.toString('base64'),
      path,
    };
  }

  async pdf(
    sessionId: string,
    options: { path?: string } = {},
  ): Promise<{ base64: string; path?: string }> {
    const session = this.getSession(sessionId);
    const pdfOptions: Record<string, unknown> = { format: 'A4' };
    if (options.path) pdfOptions.path = options.path;

    const buffer = await session.page.pdf(pdfOptions);
    return {
      base64: buffer.toString('base64'),
      path: options.path,
    };
  }
}
