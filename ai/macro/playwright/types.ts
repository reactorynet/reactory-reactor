/**
 * Macro prop/result types for the Playwright macro set.
 *
 * All prop interfaces use string-serializable types so the AI agent
 * can pass them via positional or named parameters.
 */

// ── Shared result shape ────────────────────────────────────

export interface PlaywrightMacroResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
  tool: string;
  params: unknown;
  metadata?: {
    executionTime: number;
    timestamp: Date;
    user?: string;
    sessionId?: string;
  };
  instructions?: string;
}

// ── Open / Close session ───────────────────────────────────

export interface OpenSessionProps {
  /** Run headless (default "true") */
  headless?: string;
  /** Viewport as "widthxheight", e.g. "1280x720" */
  viewport?: string;
  /** Custom user agent string */
  userAgent?: string;
  /** Default navigation timeout in ms */
  timeout?: string;
}

export interface CloseSessionProps {
  /** Session to close (defaults to state.vars.playwrightSessionId) */
  sessionId?: string;
}

// ── Navigation ─────────────────────────────────────────────

export interface NavigateProps {
  /** URL to navigate to */
  url: string;
  /** When to consider navigation succeeded */
  waitUntil?: string;
  /** Session to use */
  sessionId?: string;
}

// ── Interaction ────────────────────────────────────────────

export interface ClickProps {
  /** CSS selector of the element to click */
  selector: string;
  /** Mouse button: left, right, middle */
  button?: string;
  /** Number of clicks */
  clickCount?: string;
  /** Timeout in ms */
  timeout?: string;
  /** Session to use */
  sessionId?: string;
}

export interface TypeProps {
  /** CSS selector of the input element */
  selector: string;
  /** Text to type */
  text: string;
  /** Delay between keystrokes in ms */
  delay?: string;
  /** Clear field before typing ("true" / "false") */
  clear?: string;
  /** Session to use */
  sessionId?: string;
}

export interface SelectProps {
  /** CSS selector of the select element */
  selector: string;
  /** Comma-separated values to select */
  values: string;
  /** Session to use */
  sessionId?: string;
}

export interface PressKeyProps {
  /** Key to press (e.g. "Enter", "Tab", "Escape") */
  key: string;
  /** Session to use */
  sessionId?: string;
}

// ── Content & Inspection ───────────────────────────────────

export interface GetContentProps {
  /** Optional CSS selector to scope content extraction */
  selector?: string;
  /** Session to use */
  sessionId?: string;
}

export interface InspectElementProps {
  /** CSS selector of the element to inspect */
  selector: string;
  /** Session to use */
  sessionId?: string;
}

export interface WaitForProps {
  /** CSS selector to wait for */
  selector: string;
  /** Target state: visible, hidden, attached, detached */
  state?: string;
  /** Timeout in ms */
  timeout?: string;
  /** Session to use */
  sessionId?: string;
}

// ── Evaluate ───────────────────────────────────────────────

export interface EvaluateProps {
  /** JavaScript code to run in the page context */
  script: string;
  /** Session to use */
  sessionId?: string;
}

// ── Capture ────────────────────────────────────────────────

export interface ScreenshotProps {
  /** Capture full scrollable page ("true" / "false") */
  fullPage?: string;
  /** File path to save the screenshot */
  path?: string;
  /** Image format: png or jpeg */
  type?: string;
  /** JPEG quality 0-100 */
  quality?: string;
  /** Session to use */
  sessionId?: string;
}

export interface PdfProps {
  /** File path to save the PDF */
  path?: string;
  /** Session to use */
  sessionId?: string;
}

// ── Info ───────────────────────────────────────────────────

export interface PageInfoProps {
  /** Session to use */
  sessionId?: string;
}

export interface ListSessionsProps {
  // no parameters needed
}
