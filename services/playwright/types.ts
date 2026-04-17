import { Browser, BrowserContext, Page } from 'playwright';

/**
 * Represents an active Playwright browser session.
 */
export interface PlaywrightSession {
  /** Unique session identifier */
  id: string;
  /** The Playwright Browser instance */
  browser: Browser;
  /** The browser context (isolated cookies, storage, etc.) */
  context: BrowserContext;
  /** The active page within the context */
  page: Page;
  /** When the session was created */
  createdAt: Date;
  /** When the session was last interacted with */
  lastActivity: Date;
  /** Whether the browser is running headless */
  headless: boolean;
}

/**
 * Options for creating a new browser session.
 */
export interface SessionOptions {
  /** Run the browser in headless mode (default: true) */
  headless?: boolean;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Custom user agent string */
  userAgent?: string;
  /** Default navigation timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Options for page navigation.
 */
export interface NavigateOptions {
  /** The URL to navigate to */
  url: string;
  /** When to consider navigation succeeded */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/**
 * Result of a navigation operation.
 */
export interface NavigateResult {
  /** The final URL after navigation (may differ due to redirects) */
  url: string;
  /** The page title */
  title: string;
  /** HTTP status code of the navigation response */
  status: number | null;
}

/**
 * Options for clicking an element.
 */
export interface ClickOptions {
  /** CSS selector for the target element */
  selector: string;
  /** Mouse button to use */
  button?: 'left' | 'right' | 'middle';
  /** Number of clicks (1 = single, 2 = double) */
  clickCount?: number;
  /** Timeout in milliseconds for finding the element */
  timeout?: number;
}

/**
 * Options for typing text into an element.
 */
export interface TypeOptions {
  /** CSS selector for the target input element */
  selector: string;
  /** Text to type */
  text: string;
  /** Delay between keystrokes in milliseconds */
  delay?: number;
  /** Whether to clear the field before typing */
  clear?: boolean;
}

/**
 * Options for taking a screenshot.
 */
export interface ScreenshotOptions {
  /** Capture the full scrollable page */
  fullPage?: boolean;
  /** File path to save the screenshot to */
  path?: string;
  /** Image format */
  type?: 'png' | 'jpeg';
  /** JPEG quality (0-100), only applicable when type is 'jpeg' */
  quality?: number;
}

/**
 * Options for evaluating JavaScript in the page context.
 */
export interface EvaluateOptions {
  /** JavaScript code to evaluate in the page context */
  script: string;
}

/**
 * Options for waiting for an element.
 */
export interface WaitOptions {
  /** CSS selector to wait for */
  selector: string;
  /** Target state of the element */
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Result of a DOM element inspection.
 */
export interface DOMInspectResult {
  /** Outer HTML of the element */
  html: string;
  /** Inner text content */
  text: string;
  /** Element attributes as key-value pairs */
  attributes: Record<string, string>;
  /** HTML tag name (lowercased) */
  tagName: string;
  /** Number of direct child elements */
  childCount: number;
  /** Whether the element is visible */
  visible: boolean;
  /** Bounding box of the element */
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Summary info for a listed session.
 */
export interface SessionInfo {
  /** Session ID */
  id: string;
  /** Current page URL */
  url: string;
  /** Current page title */
  title: string;
  /** When the session was created */
  createdAt: Date;
  /** When the session was last used */
  lastActivity: Date;
  /** Whether the browser is headless */
  headless: boolean;
}

/**
 * Current page metadata.
 */
export interface PageInfo {
  /** Current page URL */
  url: string;
  /** Current page title */
  title: string;
  /** Current viewport dimensions */
  viewport: { width: number; height: number } | null;
}
