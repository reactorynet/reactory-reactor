import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

import ReactorPlaywrightService from '../../services/playwright/ReactorPlaywrightService';
import {
  PlaywrightOpenSession,
  PlaywrightCloseSession,
  PlaywrightNavigate,
  PlaywrightClick,
  PlaywrightType,
  PlaywrightGetContent,
  PlaywrightInspectElement,
  PlaywrightEvaluate,
  PlaywrightScreenshot,
  PlaywrightPageInfo,
  PlaywrightListSessions,
} from '../../ai/macro/playwright/macro';
import type { ChatState } from '../../ai/openai/types/chat';
import { PlaywrightSessionStep } from '../../workflow/steps/playwright/PlaywrightSessionStep';
import { PlaywrightNavigateStep } from '../../workflow/steps/playwright/PlaywrightNavigateStep';
import { PlaywrightActionStep } from '../../workflow/steps/playwright/PlaywrightActionStep';
import { PlaywrightEvaluateStep } from '../../workflow/steps/playwright/PlaywrightEvaluateStep';
import { PlaywrightInspectStep } from '../../workflow/steps/playwright/PlaywrightInspectStep';
import { PlaywrightScreenshotStep } from '../../workflow/steps/playwright/PlaywrightScreenshotStep';
import { PlaywrightStep } from '../../workflow/steps/playwright/PlaywrightStep';
import { PLAYWRIGHT_SERVICE_ID } from '../../workflow/steps/playwright/BasePlaywrightStep';

/**
 * Runtime proof that playwright and its provisioned Chromium actually work.
 *
 * WHY THIS EXISTS
 * ---------------
 * `PlaywrightBrowserProvisioning.unit.test.ts` proves a matching browser is on disk and that
 * `chromium.launch()` returns. That is necessary but not sufficient: a playwright upgrade can
 * keep `launch()` working while breaking navigation, evaluation, inspection, clicking or
 * screenshotting. So this suite drives the real consumer surfaces against a real headless
 * Chromium and a real HTTP server on 127.0.0.1, with **no playwright mock anywhere**:
 *
 *   1. `services/playwright/ReactorPlaywrightService.ts` — the service every surface delegates to.
 *   2. `ai/macro/playwright/macro.ts` — the chat macro surface the AI agent calls.
 *   3. `workflow/steps/playwright/*.ts` — all seven registered workflow step types.
 *
 * Coverage boundary, stated precisely: the macros are exercised through their exported functions
 * with a real `ChatState`. The `*Registry` metadata objects (descriptions and JSON schemas, no
 * browser behaviour) are not. Three of the fifteen macros are not driven here —
 * `PlaywrightSelect` and `PlaywrightPressKey` need form controls the shared fixture does not have,
 * and `PlaywrightPdf` renders through the headless shell's PDF pipeline, which the launch gate's
 * PNG screenshot does not stand in for. They remain covered only by the mocked
 * `PlaywrightMacros.unit.test.ts`, exactly as before this change.
 *
 * If no browser is provisioned, `beforeAll` fails on the first launch with playwright's own
 * "Executable doesn't exist" message — the same failure the image build gate produces.
 */

const PAGE_HTML = `<!doctype html>
<html>
  <head><title>Reactory Playwright Runtime Check</title></head>
  <body>
    <h1 id="heading" data-kind="title">Browser runtime OK</h1>
    <input id="field" type="text" />
    <button id="button">Swap</button>
    <div id="result">idle</div>
    <script>
      document.getElementById('button').addEventListener('click', () => {
        document.getElementById('result').textContent = 'clicked';
        document.getElementById('heading').textContent = 'Heading swapped';
      });
    </script>
  </body>
</html>`;

let server: http.Server;
let baseUrl: string;
let artifactsRoot: string;
let service: ReactorPlaywrightService;

interface StepContext {
  logger: {
    info: () => void;
    warn: () => void;
    error: () => void;
    debug: () => void;
  };
  reactoryContext: { getService: (fqn: string) => unknown };
  vars: Record<string, unknown>;
  workflowInstanceId: string;
}

function makeContext(vars: Record<string, unknown> = {}): StepContext {
  return {
    // Silent logger: the steps narrate every action and the noise buries the assertions.
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    reactoryContext: {
      getService: (fqn: string) => (fqn === PLAYWRIGHT_SERVICE_ID ? service : undefined),
    },
    vars,
    workflowInstanceId: 'playwright-browser-runtime',
  };
}

/** The `ChatState` the chat macros receive, wired to the REAL service — not a mock. */
function makeMacroState(): ChatState {
  return {
    context: {
      getService: (fqn: string) => (fqn === PLAYWRIGHT_SERVICE_ID ? service : undefined),
    } as unknown as Reactory.Server.IReactoryContext,
    user: { id: 'runtime-check-user' } as unknown as Reactory.Models.IUserDocument,
    vars: {},
  } as unknown as ChatState;
}

function isPng(file: string): boolean {
  const buffer = fs.readFileSync(file);
  return buffer.length > 8
    && buffer[0] === 0x89
    && buffer.toString('latin1', 1, 4) === 'PNG';
}

beforeAll(async () => {
  artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-pw-artifacts-'));
  process.env.REACTORY_DATA = artifactsRoot;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/`;

  service = new ReactorPlaywrightService({} as never, {} as never);
}, 60_000);

afterAll(async () => {
  if (service) await service.onShutdown();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (artifactsRoot) fs.rmSync(artifactsRoot, { recursive: true, force: true });
  delete process.env.REACTORY_DATA;
});

describe('ReactorPlaywrightService against a provisioned browser', () => {
  it('navigates, reads content, inspects DOM and captures a real screenshot', async () => {
    const { sessionId } = await service.createSession({
      headless: true,
      viewport: { width: 1024, height: 768 },
    });
    expect(typeof sessionId).toBe('string');

    try {
      const navigation = await service.navigate(sessionId, { url: baseUrl, waitUntil: 'load' });
      expect(navigation.status).toBe(200);
      expect(navigation.title).toBe('Reactory Playwright Runtime Check');
      expect(navigation.url).toBe(baseUrl);

      const pageInfo = await service.getPageInfo(sessionId);
      expect(pageInfo.viewport).toEqual({ width: 1024, height: 768 });

      const evaluated = await service.evaluate(sessionId, { script: 'document.title' });
      expect(evaluated.result).toBe('Reactory Playwright Runtime Check');

      const inspected = await service.inspectElement(sessionId, '#heading');
      expect(inspected.tagName).toBe('h1');
      expect(inspected.text).toBe('Browser runtime OK');
      expect(inspected.attributes['data-kind']).toBe('title');
      expect(inspected.visible).toBe(true);
      expect(inspected.boundingBox).not.toBeNull();

      const content = await service.getContent(sessionId);
      expect(content.text).toContain('Browser runtime OK');

      const scoped = await service.getContent(sessionId, '#result');
      expect(scoped.text).toBe('idle');

      const found = await service.waitForSelector(sessionId, { selector: '#button' });
      expect(found.found).toBe(true);

      const shotPath = path.join(artifactsRoot, 'service-shot.png');
      const shot = await service.screenshot(sessionId, { path: shotPath, fullPage: true });
      expect(shot.base64.length).toBeGreaterThan(0);
      expect(fs.existsSync(shotPath)).toBe(true);
      expect(isPng(shotPath)).toBe(true);

      const sessions = service.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(sessionId);
    } finally {
      await service.closeSession(sessionId);
    }

    expect(service.listSessions()).toHaveLength(0);
  }, 120_000);
});

describe('playwright chat macros against a provisioned browser', () => {
  it('opens, navigates, reads, inspects, clicks, types, evaluates, screenshots and closes', async () => {
    const state = makeMacroState();

    const opened = await PlaywrightOpenSession({ headless: 'true', viewport: '1024x768' }, state);
    expect(opened.success).toBe(true);
    const sessionId = (opened.data as Record<string, unknown>).sessionId as string;
    expect(typeof sessionId).toBe('string');
    // Chaining is the macro's job: it stores the session in state for the next macro.
    expect(state.vars.playwrightSessionId).toBe(sessionId);

    const navigated = await PlaywrightNavigate({ url: baseUrl, waitUntil: 'load' }, state);
    expect(navigated.success).toBe(true);
    expect((navigated.data as Record<string, unknown>).status).toBe(200);
    expect((navigated.data as Record<string, unknown>).title).toBe('Reactory Playwright Runtime Check');
    expect(state.vars.playwrightCurrentUrl).toBe(baseUrl);

    const pageInfo = await PlaywrightPageInfo({}, state);
    expect(pageInfo.success).toBe(true);
    expect((pageInfo.data as Record<string, unknown>).viewport).toEqual({ width: 1024, height: 768 });

    const content = await PlaywrightGetContent({ selector: '#heading' }, state);
    expect(content.success).toBe(true);
    expect((content.data as Record<string, unknown>).text).toBe('Browser runtime OK');

    const inspected = await PlaywrightInspectElement({ selector: '#heading' }, state);
    expect(inspected.success).toBe(true);
    expect((inspected.data as Record<string, unknown>).tagName).toBe('h1');
    expect((inspected.data as Record<string, unknown>).attributes).toMatchObject({ 'data-kind': 'title' });

    const evaluated = await PlaywrightEvaluate({ script: 'document.querySelectorAll("h1").length' }, state);
    expect(evaluated.success).toBe(true);
    expect((evaluated.data as Record<string, unknown>).result).toBe(1);

    const clicked = await PlaywrightClick({ selector: '#button' }, state);
    expect(clicked.success).toBe(true);
    // The click has to have reached the page, not merely returned success.
    const afterClick = await PlaywrightGetContent({ selector: '#result' }, state);
    expect((afterClick.data as Record<string, unknown>).text).toBe('clicked');

    const typed = await PlaywrightType({ selector: '#field', text: 'reactory' }, state);
    expect(typed.success).toBe(true);
    const typedValue = await PlaywrightEvaluate(
      { script: 'document.getElementById("field").value' },
      state,
    );
    expect((typedValue.data as Record<string, unknown>).result).toBe('reactory');

    const shotPath = path.join(artifactsRoot, 'macro-shot.png');
    const screenshot = await PlaywrightScreenshot(
      { path: shotPath, fullPage: 'true', type: 'png' },
      state,
    );
    expect(screenshot.success).toBe(true);
    expect((screenshot.data as Record<string, unknown>).path).toBe(shotPath);
    expect(fs.existsSync(shotPath)).toBe(true);
    expect(isPng(shotPath)).toBe(true);

    const listed = await PlaywrightListSessions({}, state);
    expect(listed.success).toBe(true);
    expect((listed.data as Record<string, unknown>).count).toBe(1);

    const closed = await PlaywrightCloseSession({}, state);
    expect(closed.success).toBe(true);
    expect(state.vars.playwrightSessionId).toBeUndefined();
    expect(service.listSessions()).toHaveLength(0);
  }, 180_000);

  it('returns a macro error instead of throwing when there is no session', async () => {
    const state = makeMacroState();
    const result = await PlaywrightNavigate({ url: baseUrl }, state);
    expect(result.success).toBe(false);
    expect(result.tool).toBe('playwright_navigate');
    expect(String(result.error)).toMatch(/session/i);
  });
});

describe('playwright workflow steps against a provisioned browser', () => {
  it('drives session -> navigate -> evaluate -> inspect -> action -> screenshot -> close', async () => {
    const context = makeContext();

    // ── 1. playwright_session (open) ───────────────────────────────────────
    const openStep = new PlaywrightSessionStep('pw-open', {
      action: 'open',
      headless: true,
      viewport: '1024x768',
    });
    const opened = await openStep.execute(context as never);
    expect(opened.success).toBe(true);
    const sessionId = (opened.outputs as Record<string, unknown>).sessionId as string;
    expect(typeof sessionId).toBe('string');
    expect(context.vars.playwrightSessionId).toBe(sessionId);

    // ── 2. playwright_navigate ─────────────────────────────────────────────
    const navigateStep = new PlaywrightNavigateStep('pw-navigate', {
      url: baseUrl,
      waitUntil: 'load',
    });
    const navigated = await navigateStep.execute(context as never);
    expect(navigated.success).toBe(true);
    expect(navigated.outputs.status).toBe(200);
    expect(navigated.outputs.title).toBe('Reactory Playwright Runtime Check');

    // ── 3. playwright_evaluate ─────────────────────────────────────────────
    const evaluateStep = new PlaywrightEvaluateStep('pw-evaluate', {
      script: 'document.querySelectorAll("h1").length',
    });
    const evaluated = await evaluateStep.execute(context as never);
    expect(evaluated.success).toBe(true);
    expect((evaluated.outputs as Record<string, unknown>).result).toBe(1);

    // ── 4. playwright_inspect ──────────────────────────────────────────────
    const inspectStep = new PlaywrightInspectStep('pw-inspect', {
      selector: '#heading',
      expectedText: 'Browser runtime OK',
    });
    const inspected = await inspectStep.execute(context as never);
    expect(inspected.success).toBe(true);

    // ── 5. playwright_action (click) ───────────────────────────────────────
    const clickStep = new PlaywrightActionStep('pw-click', {
      action: 'click',
      selector: '#button',
    });
    const clicked = await clickStep.execute(context as never);
    expect(clicked.success).toBe(true);

    // The click has to have actually reached the DOM, not just returned success.
    const afterClick = await service.evaluate(sessionId, {
      script: 'document.getElementById("result").textContent',
    });
    expect(afterClick.result).toBe('clicked');

    // ── 6. playwright_action (type into an input) ──────────────────────────
    const typeStep = new PlaywrightActionStep('pw-type', {
      action: 'type',
      selector: '#field',
      text: 'reactory',
    });
    const typed = await typeStep.execute(context as never);
    expect(typed.success).toBe(true);
    const typedValue = await service.evaluate(sessionId, {
      script: 'document.getElementById("field").value',
    });
    expect(typedValue.result).toBe('reactory');

    // ── 7. playwright_screenshot ───────────────────────────────────────────
    const screenshotStep = new PlaywrightScreenshotStep('pw-screenshot', {
      name: 'step-screenshot',
      fullPage: true,
      type: 'png',
    });
    const screenshot = await screenshotStep.execute(context as never);
    expect(screenshot.success).toBe(true);
    const shotPath = (screenshot.outputs as Record<string, unknown>).path as string;
    expect(typeof shotPath).toBe('string');
    expect(fs.existsSync(shotPath)).toBe(true);
    expect(isPng(shotPath)).toBe(true);

    // ── 8. the unified playwright step ─────────────────────────────────────
    const unifiedStep = new PlaywrightStep('pw-unified', { operation: 'navigate', url: baseUrl });
    const unified = await unifiedStep.execute(makeContext({ playwrightSessionId: sessionId }) as never);
    expect(unified.success).toBe(true);

    // ── 9. playwright_session (list) ───────────────────────────────────────
    const listStep = new PlaywrightSessionStep('pw-list', { action: 'list' });
    const listed = await listStep.execute(context as never);
    expect(listed.success).toBe(true);
    expect((listed.outputs as Record<string, unknown>).count).toBe(1);

    // ── 10. playwright_session (close) ─────────────────────────────────────
    const closeStep = new PlaywrightSessionStep('pw-close', { action: 'close' });
    const closed = await closeStep.execute(context as never);
    expect(closed.success).toBe(true);
    expect((closed.outputs as Record<string, unknown>).closed).toBe(true);
    expect(service.listSessions()).toHaveLength(0);

    // The steps must have written their session activity trail, which is how an operator
    // reconstructs what a workflow did.
    const artifactsDir = (opened.outputs as Record<string, unknown>).artifactsDir as string;
    const sessionJson = path.join(artifactsDir, 'session.json');
    expect(fs.existsSync(sessionJson)).toBe(true);
    const activity = JSON.parse(fs.readFileSync(sessionJson, 'utf8'));
    expect(activity.history.length).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
