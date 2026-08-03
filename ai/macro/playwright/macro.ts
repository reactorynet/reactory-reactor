import fs from 'fs';
import path from 'path';
import { safeCDNUrl } from '@reactory/server-core/utils/url/safeUrl';
import {
  ChatState,
  Macro,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';
import type ReactorPlaywrightService from '@reactory/server-modules/reactory-reactor/services/playwright/ReactorPlaywrightService';
import {
  PlaywrightMacroResult,
  OpenSessionProps,
  CloseSessionProps,
  NavigateProps,
  ClickProps,
  TypeProps,
  SelectProps,
  PressKeyProps,
  GetContentProps,
  InspectElementProps,
  WaitForProps,
  EvaluateProps,
  ScreenshotProps,
  PdfProps,
  PageInfoProps,
  ListSessionsProps,
} from './types';

const SERVICE_FQN = 'reactor.ReactorPlaywrightService@1.0.0';

/**
 * Resolves the Playwright service from the chat state context.
 */
function getPlaywrightService(state: ChatState): ReactorPlaywrightService {
  const svc = state.context?.getService<ReactorPlaywrightService>(SERVICE_FQN);
  if (!svc) {
    throw new Error('ReactorPlaywrightService is not available. Ensure the service is registered and the server module is loaded.');
  }
  return svc;
}

/**
 * Resolves the session ID — explicit param takes precedence, then state var.
 */
function resolveSessionId(explicit: string | undefined, state: ChatState): string {
  const id = explicit || (state.vars?.playwrightSessionId as string);
  if (!id) {
    throw new Error('No sessionId provided and no active session in state. Call playwright_open_session first.');
  }
  return id;
}

/**
 * Helper to build a standard error result.
 */
function errorResult(tool: string, params: unknown, error: string, startTime: number, state: ChatState): PlaywrightMacroResult {
  return {
    success: false,
    error,
    tool,
    params,
    metadata: {
      executionTime: Date.now() - startTime,
      timestamp: new Date(),
      user: state.user?.fullName ?? state.user?.id?.toString() ?? 'unknown',
    },
  };
}

// ── Open Session ───────────────────────────────────────────

export const PlaywrightOpenSession: Macro<PlaywrightMacroResult, OpenSessionProps> = async (
  props: OpenSessionProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const headless = props.headless !== 'false';
    let viewport: { width: number; height: number } | undefined;
    if (props.viewport) {
      const [w, h] = props.viewport.split('x').map(Number);
      if (w && h) viewport = { width: w, height: h };
    }
    const timeout = props.timeout ? parseInt(props.timeout, 10) : undefined;

    const { sessionId } = await svc.createSession({
      headless,
      viewport,
      userAgent: props.userAgent,
      timeout,
    });

    if (!state.vars) state.vars = {};
    state.vars.playwrightSessionId = sessionId;

    logger.info(`PlaywrightOpenSession: created session ${sessionId} for user ${state.user?.id || 'unknown'}`);

    return {
      success: true,
      data: { sessionId, headless, viewport: viewport || { width: 1280, height: 720 } },
      tool: 'playwright_open_session',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Browser Session Opened

A new Playwright browser session has been created.

- **Session ID**: \`${sessionId}\`
- **Headless**: ${headless}
- **Viewport**: ${viewport ? `${viewport.width}x${viewport.height}` : '1280x720'}

The session ID has been stored in \`state.vars.playwrightSessionId\` and will be used automatically by subsequent playwright macros.

### Next Steps:
- Use \`playwright_navigate\` to open a URL
- Use \`playwright_close_session\` when done to free resources
`,
    };
  } catch (err) {
    return errorResult('playwright_open_session', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Close Session ──────────────────────────────────────────

export const PlaywrightCloseSession: Macro<PlaywrightMacroResult, CloseSessionProps> = async (
  props: CloseSessionProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);
    await svc.closeSession(sessionId);

    if (state.vars?.playwrightSessionId === sessionId) {
      delete state.vars.playwrightSessionId;
    }

    return {
      success: true,
      data: { sessionId },
      tool: 'playwright_close_session',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Session Closed

Browser session \`${sessionId}\` has been closed and resources freed.

Use \`playwright_open_session\` to start a new session if needed.
`,
    };
  } catch (err) {
    return errorResult('playwright_close_session', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Navigate ───────────────────────────────────────────────

export const PlaywrightNavigate: Macro<PlaywrightMacroResult, NavigateProps> = async (
  props: NavigateProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.url) {
      return errorResult('playwright_navigate', props, 'URL is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);
    const waitUntil = (props.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | 'commit') || 'load';

    const result = await svc.navigate(sessionId, { url: props.url, waitUntil });

    if (!state.vars) state.vars = {};
    state.vars.playwrightCurrentUrl = result.url;

    return {
      success: true,
      data: result,
      tool: 'playwright_navigate',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Navigation Complete

- **URL**: ${result.url}
- **Title**: ${result.title}
- **Status**: ${result.status}
- **Load Time**: ${Date.now() - startTime}ms

### Next Steps:
- Use \`playwright_get_content\` to read page content
- Use \`playwright_screenshot\` to capture the page visually
- Use \`playwright_click\` or \`playwright_type\` to interact with elements
- Use \`playwright_inspect\` to examine specific elements
- Use \`playwright_wait_for\` to wait for dynamic content
`,
    };
  } catch (err) {
    return errorResult('playwright_navigate', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Click ──────────────────────────────────────────────────

export const PlaywrightClick: Macro<PlaywrightMacroResult, ClickProps> = async (
  props: ClickProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.selector) {
      return errorResult('playwright_click', props, 'selector is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    await svc.click(sessionId, {
      selector: props.selector,
      button: (props.button as 'left' | 'right' | 'middle') || 'left',
      clickCount: props.clickCount ? parseInt(props.clickCount, 10) : 1,
      timeout: props.timeout ? parseInt(props.timeout, 10) : undefined,
    });

    return {
      success: true,
      data: { selector: props.selector, clicked: true },
      tool: 'playwright_click',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Click Completed

Clicked element matching \`${props.selector}\`.

### Next Steps:
- Use \`playwright_wait_for\` if the click triggers dynamic content loading
- Use \`playwright_screenshot\` to verify the visual state
- Use \`playwright_get_content\` to read updated content
`,
    };
  } catch (err) {
    return errorResult('playwright_click', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Type ───────────────────────────────────────────────────

export const PlaywrightType: Macro<PlaywrightMacroResult, TypeProps> = async (
  props: TypeProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.selector || !props.text) {
      return errorResult('playwright_type', props, 'selector and text are required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    await svc.type(sessionId, {
      selector: props.selector,
      text: props.text,
      delay: props.delay ? parseInt(props.delay, 10) : 0,
      clear: props.clear === 'true',
    });

    return {
      success: true,
      data: { selector: props.selector, text: props.text },
      tool: 'playwright_type',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Text Typed

Typed "${props.text.length > 50 ? props.text.substring(0, 50) + '...' : props.text}" into \`${props.selector}\`.

### Next Steps:
- Use \`playwright_press_key\` to press Enter or Tab
- Use \`playwright_click\` to click a submit button
- Use \`playwright_screenshot\` to verify the input
`,
    };
  } catch (err) {
    return errorResult('playwright_type', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Select ─────────────────────────────────────────────────

export const PlaywrightSelect: Macro<PlaywrightMacroResult, SelectProps> = async (
  props: SelectProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.selector || !props.values) {
      return errorResult('playwright_select', props, 'selector and values are required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);
    const values = props.values.split(',').map((v) => v.trim());

    const result = await svc.select(sessionId, props.selector, values);

    return {
      success: true,
      data: result,
      tool: 'playwright_select',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Option Selected

Selected values [${result.selectedValues.join(', ')}] in \`${props.selector}\`.
`,
    };
  } catch (err) {
    return errorResult('playwright_select', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Press Key ──────────────────────────────────────────────

export const PlaywrightPressKey: Macro<PlaywrightMacroResult, PressKeyProps> = async (
  props: PressKeyProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.key) {
      return errorResult('playwright_press_key', props, 'key is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    await svc.pressKey(sessionId, props.key);

    return {
      success: true,
      data: { key: props.key },
      tool: 'playwright_press_key',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Key Pressed

Pressed \`${props.key}\` key.
`,
    };
  } catch (err) {
    return errorResult('playwright_press_key', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Get Content ────────────────────────────────────────────

export const PlaywrightGetContent: Macro<PlaywrightMacroResult, GetContentProps> = async (
  props: GetContentProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const result = await svc.getContent(sessionId, props.selector);

    const truncatedHtml = result.html.length > 10_000
      ? result.html.substring(0, 10_000) + '\n... [truncated]'
      : result.html;

    const truncatedText = result.text.length > 10_000
      ? result.text.substring(0, 10_000) + '\n... [truncated]'
      : result.text;

    return {
      success: true,
      data: { html: truncatedHtml, text: truncatedText, fullLength: { html: result.html.length, text: result.text.length } },
      tool: 'playwright_get_content',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Page Content Retrieved

${props.selector ? `Content from selector \`${props.selector}\`` : 'Full page content'}:
- **HTML length**: ${result.html.length} chars${result.html.length > 10_000 ? ' (truncated to 10,000)' : ''}
- **Text length**: ${result.text.length} chars${result.text.length > 10_000 ? ' (truncated to 10,000)' : ''}

### Available Data:
- **html**: The raw HTML content
- **text**: The visible text content

### Next Steps:
- Use \`playwright_inspect\` for detailed element inspection
- Use \`playwright_evaluate\` to run JavaScript for custom extraction
`,
    };
  } catch (err) {
    return errorResult('playwright_get_content', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Inspect Element ────────────────────────────────────────

export const PlaywrightInspectElement: Macro<PlaywrightMacroResult, InspectElementProps> = async (
  props: InspectElementProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.selector) {
      return errorResult('playwright_inspect', props, 'selector is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const result = await svc.inspectElement(sessionId, props.selector);

    return {
      success: true,
      data: result,
      tool: 'playwright_inspect',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Element Inspection

- **Tag**: \`<${result.tagName}>\`
- **Visible**: ${result.visible}
- **Children**: ${result.childCount}
- **Attributes**: ${Object.entries(result.attributes).map(([k, v]) => `${k}="${v}"`).join(', ') || 'none'}
- **Bounding Box**: ${result.boundingBox ? `${result.boundingBox.width}x${result.boundingBox.height} at (${result.boundingBox.x}, ${result.boundingBox.y})` : 'N/A'}
- **Text**: ${result.text.substring(0, 200)}${result.text.length > 200 ? '...' : ''}

### Available Data:
- **html**: Outer HTML of the element
- **text**: Inner text content
- **attributes**: All element attributes
- **tagName**: HTML tag name
- **childCount**: Number of direct children
- **visible**: Visibility state
- **boundingBox**: Position and dimensions
`,
    };
  } catch (err) {
    return errorResult('playwright_inspect', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Wait For ───────────────────────────────────────────────

export const PlaywrightWaitFor: Macro<PlaywrightMacroResult, WaitForProps> = async (
  props: WaitForProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.selector) {
      return errorResult('playwright_wait_for', props, 'selector is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const result = await svc.waitForSelector(sessionId, {
      selector: props.selector,
      state: (props.state as 'visible' | 'hidden' | 'attached' | 'detached') || 'visible',
      timeout: props.timeout ? parseInt(props.timeout, 10) : undefined,
    });

    return {
      success: true,
      data: result,
      tool: 'playwright_wait_for',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Wait Result

- **Selector**: \`${props.selector}\`
- **State**: ${props.state || 'visible'}
- **Found**: ${result.found}
- **Wait Time**: ${Date.now() - startTime}ms

${result.found
    ? 'The element is now available. You can interact with it using click, type, inspect, etc.'
    : 'The element was not found within the timeout period. You may want to check the selector or increase the timeout.'}
`,
    };
  } catch (err) {
    return errorResult('playwright_wait_for', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Evaluate ───────────────────────────────────────────────

export const PlaywrightEvaluate: Macro<PlaywrightMacroResult, EvaluateProps> = async (
  props: EvaluateProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    if (!props.script) {
      return errorResult('playwright_evaluate', props, 'script is required', startTime, state);
    }
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const { result } = await svc.evaluate(sessionId, { script: props.script });

    let serializedResult: unknown;
    try {
      serializedResult = JSON.parse(JSON.stringify(result));
    } catch {
      serializedResult = String(result);
    }

    return {
      success: true,
      data: { result: serializedResult },
      tool: 'playwright_evaluate',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## JavaScript Evaluation Result

Script executed successfully in the page context.

- **Execution Time**: ${Date.now() - startTime}ms
- **Result Type**: ${typeof result}

The \`result\` field contains the return value of the evaluated script.
`,
    };
  } catch (err) {
    return errorResult('playwright_evaluate', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Screenshot ─────────────────────────────────────────────

export const PlaywrightScreenshot: Macro<PlaywrightMacroResult, ScreenshotProps> = async (
  props: ScreenshotProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT || '/tmp';
    const personaId = state.personaId || 'reactor';
    const workspaceDir = path.join(dataRoot, 'profiles', 'reactor', 'personas', personaId, 'workspace');

    // Ensure the workspace directory exists
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const format = (props.type as 'png' | 'jpeg') || 'png';
    const filename = `screenshot_${Date.now()}.${format}`;
    const screenshotPath = props.path || path.join(workspaceDir, filename);

    const result = await svc.screenshot(sessionId, {
      fullPage: props.fullPage === 'true',
      path: screenshotPath,
      type: format,
      quality: props.quality ? parseInt(props.quality, 10) : undefined,
    });

    const sizeKb = Math.round((result.base64.length * 3) / 4 / 1024);

    let imageUrl: string | undefined;
    if (screenshotPath.startsWith(dataRoot)) {
      const relativePath = path.relative(dataRoot, screenshotPath);
      imageUrl = safeCDNUrl(relativePath);
    }

    return {
      success: true,
      data: { url: imageUrl, path: screenshotPath, sizeKb },
      tool: 'playwright_screenshot',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Screenshot Captured

- **Format**: ${format}
- **Full Page**: ${props.fullPage === 'true'}
- **Size**: ~${sizeKb} KB
- **Saved to**: ${screenshotPath}
${imageUrl ? `- **View Image**: [Open in new tab](${imageUrl})\n\n![Screenshot](${imageUrl})` : ''}
`,
    };
  } catch (err) {
    return errorResult('playwright_screenshot', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── PDF ────────────────────────────────────────────────────

export const PlaywrightPdf: Macro<PlaywrightMacroResult, PdfProps> = async (
  props: PdfProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT || '/tmp';
    const personaId = state.personaId || 'reactor';
    const workspaceDir = path.join(dataRoot, 'profiles', 'reactor', 'personas', personaId, 'workspace');

    // Ensure the workspace directory exists
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const pdfPath = props.path || path.join(workspaceDir, `pdf_${Date.now()}.pdf`);

    const result = await svc.pdf(sessionId, { path: pdfPath });
    const sizeKb = Math.round((result.base64.length * 3) / 4 / 1024);

    let pdfUrl: string | undefined;
    if (pdfPath.startsWith(dataRoot)) {
      const relativePath = path.relative(dataRoot, pdfPath);
      pdfUrl = safeCDNUrl(relativePath);
    }

    return {
      success: true,
      data: { url: pdfUrl, path: pdfPath, sizeKb },
      tool: 'playwright_pdf',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## PDF Generated

- **Size**: ~${sizeKb} KB
- **Saved to**: ${pdfPath}
${pdfUrl ? `- **Download PDF**: [Open PDF](${pdfUrl})` : ''}

Note: PDF generation only works in Chromium headless mode.
`,
    };
  } catch (err) {
    return errorResult('playwright_pdf', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Page Info ──────────────────────────────────────────────

export const PlaywrightPageInfo: Macro<PlaywrightMacroResult, PageInfoProps> = async (
  props: PageInfoProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessionId = resolveSessionId(props.sessionId, state);

    const info = await svc.getPageInfo(sessionId);

    return {
      success: true,
      data: info,
      tool: 'playwright_page_info',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
        sessionId,
      },
      instructions: `## Page Info

- **URL**: ${info.url}
- **Title**: ${info.title}
- **Viewport**: ${info.viewport ? `${info.viewport.width}x${info.viewport.height}` : 'N/A'}
`,
    };
  } catch (err) {
    return errorResult('playwright_page_info', props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── List Sessions ──────────────────────────────────────────

export const PlaywrightListSessions: Macro<PlaywrightMacroResult, ListSessionsProps> = async (
  _props: ListSessionsProps,
  state: ChatState,
): Promise<PlaywrightMacroResult> => {
  const startTime = Date.now();
  try {
    const svc = getPlaywrightService(state);
    const sessions = svc.listSessions();

    return {
      success: true,
      data: { sessions, count: sessions.length },
      tool: 'playwright_list_sessions',
      params: _props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id as string,
      },
      instructions: `## Active Browser Sessions

${sessions.length === 0 ? 'No active sessions. Use \`playwright_open_session\` to create one.' :
    sessions.map((s) => `- **${s.id}**: ${s.url} (headless=${s.headless}, idle ${Math.round((Date.now() - s.lastActivity.getTime()) / 1000)}s)`).join('\n')}

**Total**: ${sessions.length} session(s)
`,
    };
  } catch (err) {
    return errorResult('playwright_list_sessions', _props, err instanceof Error ? err.message : String(err), startTime, state);
  }
};

// ── Tool Definitions & Registry ────────────────────────────

const COMMON_SESSION_PARAM = {
  sessionId: {
    type: 'string' as const,
    description: 'Session ID to use. Defaults to the active session from state.',
  },
};

export const PlaywrightOpenSessionRegistry: MacroComponentDefinition<typeof PlaywrightOpenSession> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_open_session',
  version: '1.0.0',
  component: PlaywrightOpenSession,
  description: 'Open a new Playwright browser session for web automation',
  features: [],
  stem: 'playwright_open_session',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'automation', 'session'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_open_session',
      description: 'Launch a new browser session. Returns a sessionId used by all other playwright macros.',
      icon: 'launch',
      parameters: {
        type: 'object',
        properties: {
          headless: { type: 'string', description: 'Run headless: "true" or "false" (default: "true")' },
          viewport: { type: 'string', description: 'Viewport size as "widthxheight", e.g. "1280x720"' },
          userAgent: { type: 'string', description: 'Custom user agent string' },
          timeout: { type: 'string', description: 'Default navigation timeout in ms' },
        },
      },
    },
  }],
};

export const PlaywrightCloseSessionRegistry: MacroComponentDefinition<typeof PlaywrightCloseSession> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_close_session',
  version: '1.0.0',
  component: PlaywrightCloseSession,
  description: 'Close a Playwright browser session and free resources',
  features: [],
  stem: 'playwright_close_session',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'session', 'close'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_close_session',
      description: 'Close a browser session. Uses active session if sessionId omitted.',
      icon: 'close',
      parameters: {
        type: 'object',
        properties: { ...COMMON_SESSION_PARAM },
      },
    },
  }],
};

export const PlaywrightNavigateRegistry: MacroComponentDefinition<typeof PlaywrightNavigate> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_navigate',
  version: '1.0.0',
  component: PlaywrightNavigate,
  description: 'Navigate the browser to a URL',
  features: [],
  stem: 'playwright_navigate',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'navigate', 'url'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_navigate',
      description: 'Navigate the browser to a URL and wait for the page to load.',
      icon: 'open_in_browser',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to' },
          waitUntil: { type: 'string', description: 'When to consider navigation done: load, domcontentloaded, networkidle, commit', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
          ...COMMON_SESSION_PARAM,
        },
        required: ['url'],
      },
    },
  }],
};

export const PlaywrightClickRegistry: MacroComponentDefinition<typeof PlaywrightClick> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_click',
  version: '1.0.0',
  component: PlaywrightClick,
  description: 'Click an element on the page by CSS selector',
  features: [],
  stem: 'playwright_click',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'click', 'interact'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_click',
      description: 'Click an element matching the given CSS selector.',
      icon: 'mouse',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element to click' },
          button: { type: 'string', description: 'Mouse button: left, right, middle', enum: ['left', 'right', 'middle'] },
          clickCount: { type: 'string', description: 'Number of clicks (1=single, 2=double)' },
          timeout: { type: 'string', description: 'Timeout in ms for finding the element' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['selector'],
      },
    },
  }],
};

export const PlaywrightTypeRegistry: MacroComponentDefinition<typeof PlaywrightType> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_type',
  version: '1.0.0',
  component: PlaywrightType,
  description: 'Type text into an input element on the page',
  features: [],
  stem: 'playwright_type',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'type', 'input'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_type',
      description: 'Type text into an input element matching the CSS selector.',
      icon: 'keyboard',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input element' },
          text: { type: 'string', description: 'Text to type' },
          delay: { type: 'string', description: 'Delay between keystrokes in ms' },
          clear: { type: 'string', description: 'Clear field before typing: "true" or "false"' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['selector', 'text'],
      },
    },
  }],
};

export const PlaywrightSelectRegistry: MacroComponentDefinition<typeof PlaywrightSelect> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_select',
  version: '1.0.0',
  component: PlaywrightSelect,
  description: 'Select option(s) from a dropdown element',
  features: [],
  stem: 'playwright_select',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'select', 'dropdown'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_select',
      description: 'Select option(s) from a <select> element by value.',
      icon: 'list',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the <select> element' },
          values: { type: 'string', description: 'Comma-separated values to select' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['selector', 'values'],
      },
    },
  }],
};

export const PlaywrightPressKeyRegistry: MacroComponentDefinition<typeof PlaywrightPressKey> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_press_key',
  version: '1.0.0',
  component: PlaywrightPressKey,
  description: 'Press a keyboard key (e.g. Enter, Tab, Escape)',
  features: [],
  stem: 'playwright_press_key',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'keyboard', 'key'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_press_key',
      description: 'Press a keyboard key. Supports named keys like Enter, Tab, Escape, ArrowDown, etc.',
      icon: 'keyboard',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['key'],
      },
    },
  }],
};

export const PlaywrightGetContentRegistry: MacroComponentDefinition<typeof PlaywrightGetContent> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_get_content',
  version: '1.0.0',
  component: PlaywrightGetContent,
  description: 'Get the HTML and text content of the page or a specific element',
  features: [],
  stem: 'playwright_get_content',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'content', 'dom', 'html'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_get_content',
      description: 'Get the HTML and text content of the page, or scope to a CSS selector.',
      icon: 'code',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to scope content extraction' },
          ...COMMON_SESSION_PARAM,
        },
      },
    },
  }],
};

export const PlaywrightInspectElementRegistry: MacroComponentDefinition<typeof PlaywrightInspectElement> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_inspect',
  version: '1.0.0',
  component: PlaywrightInspectElement,
  description: 'Inspect a DOM element: tag, attributes, visibility, bounding box, children',
  features: [],
  stem: 'playwright_inspect',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'inspect', 'dom', 'element'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_inspect',
      description: 'Inspect a DOM element by CSS selector. Returns tag, attributes, visibility, bounding box, text, and child count.',
      icon: 'search',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element to inspect' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['selector'],
      },
    },
  }],
};

export const PlaywrightWaitForRegistry: MacroComponentDefinition<typeof PlaywrightWaitFor> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_wait_for',
  version: '1.0.0',
  component: PlaywrightWaitFor,
  description: 'Wait for a DOM element to reach a target state (visible, hidden, attached, detached)',
  features: [],
  stem: 'playwright_wait_for',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'wait', 'selector'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_wait_for',
      description: 'Wait for an element matching the CSS selector to reach the specified state.',
      icon: 'hourglass_empty',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          state: { type: 'string', description: 'Target state', enum: ['visible', 'hidden', 'attached', 'detached'] },
          timeout: { type: 'string', description: 'Timeout in ms' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['selector'],
      },
    },
  }],
};

export const PlaywrightEvaluateRegistry: MacroComponentDefinition<typeof PlaywrightEvaluate> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_evaluate',
  version: '1.0.0',
  component: PlaywrightEvaluate,
  description: 'Evaluate JavaScript in the page context and return the result',
  features: [],
  stem: 'playwright_evaluate',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'evaluate', 'javascript', 'js'],
  tools: [{
    type: 'function',
    safeForAutoExecution: false,
    function: {
      name: 'playwright_evaluate',
      description: 'Run JavaScript code in the browser page context and return the result.',
      icon: 'code',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to evaluate in the page context' },
          ...COMMON_SESSION_PARAM,
        },
        required: ['script'],
      },
    },
  }],
};

export const PlaywrightScreenshotRegistry: MacroComponentDefinition<typeof PlaywrightScreenshot> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_screenshot',
  version: '1.0.0',
  component: PlaywrightScreenshot,
  description: 'Take a screenshot of the page, optionally saving to a file',
  features: [],
  stem: 'playwright_screenshot',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'screenshot', 'capture'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_screenshot',
      description: 'Capture a screenshot of the current page. Returns base64-encoded image.',
      icon: 'photo_camera',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'string', description: 'Capture full scrollable page: "true" or "false"' },
          path: { type: 'string', description: 'File path to save the screenshot' },
          type: { type: 'string', description: 'Image format', enum: ['png', 'jpeg'] },
          quality: { type: 'string', description: 'JPEG quality 0-100 (only for jpeg)' },
          ...COMMON_SESSION_PARAM,
        },
      },
    },
  }],
};

export const PlaywrightPdfRegistry: MacroComponentDefinition<typeof PlaywrightPdf> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_pdf',
  version: '1.0.0',
  component: PlaywrightPdf,
  description: 'Export the current page as a PDF document',
  features: [],
  stem: 'playwright_pdf',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'pdf', 'export'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_pdf',
      description: 'Export the current page as PDF. Only works in Chromium headless mode.',
      icon: 'picture_as_pdf',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to save the PDF' },
          ...COMMON_SESSION_PARAM,
        },
      },
    },
  }],
};

export const PlaywrightPageInfoRegistry: MacroComponentDefinition<typeof PlaywrightPageInfo> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_page_info',
  version: '1.0.0',
  component: PlaywrightPageInfo,
  description: 'Get current page URL, title, and viewport info',
  features: [],
  stem: 'playwright_page_info',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'page', 'info'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_page_info',
      description: 'Get the current page URL, title, and viewport dimensions.',
      icon: 'info',
      parameters: {
        type: 'object',
        properties: { ...COMMON_SESSION_PARAM },
      },
    },
  }],
};

export const PlaywrightListSessionsRegistry: MacroComponentDefinition<typeof PlaywrightListSessions> = {
  nameSpace: 'reactor-macros',
  name: 'playwright_list_sessions',
  version: '1.0.0',
  component: PlaywrightListSessions,
  description: 'List all active Playwright browser sessions',
  features: [],
  stem: 'playwright_list_sessions',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['playwright', 'browser', 'sessions', 'list'],
  tools: [{
    type: 'function',
    safeForAutoExecution: true,
    function: {
      name: 'playwright_list_sessions',
      description: 'List all active browser sessions with their URLs and idle times.',
      icon: 'list',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }],
};

/**
 * All Playwright macro registry entries exported as an array.
 */
export const PlaywrightMacros: MacroComponentDefinition<unknown>[] = [
  PlaywrightOpenSessionRegistry,
  PlaywrightCloseSessionRegistry,
  PlaywrightNavigateRegistry,
  PlaywrightClickRegistry,
  PlaywrightTypeRegistry,
  PlaywrightSelectRegistry,
  PlaywrightPressKeyRegistry,
  PlaywrightGetContentRegistry,
  PlaywrightInspectElementRegistry,
  PlaywrightWaitForRegistry,
  PlaywrightEvaluateRegistry,
  PlaywrightScreenshotRegistry,
  PlaywrightPdfRegistry,
  PlaywrightPageInfoRegistry,
  PlaywrightListSessionsRegistry,
];
