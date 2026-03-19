/**
 * Blessed screen layout for ReactorTUI.
 *
 * Creates the main screen and all panels (chat, input, status bar,
 * side panels) and returns handles to them for the main TUI orchestrator.
 */
import * as blessed from "neo-blessed";
import { TUITheme } from "../types";
import { DEFAULT_THEME } from "../theme";

export interface LayoutElements {
  screen: blessed.Widgets.Screen;
  statusBar: blessed.Widgets.BoxElement;
  chatPanel: blessed.Widgets.Log;
  inputPanel: blessed.Widgets.TextareaElement;
  sidePanel: blessed.Widgets.BoxElement;
  sidePanelTitle: blessed.Widgets.BoxElement;
  sidePanelContent: blessed.Widgets.BoxElement;
  thinkingPanel: blessed.Widgets.BoxElement;
  helpOverlay: blessed.Widgets.BoxElement;
  confirmDialog: blessed.Widgets.BoxElement;
  spinnerInterval: NodeJS.Timeout | null;
}

/**
 * Create the full blessed layout.
 */
export function createLayout(theme: TUITheme = DEFAULT_THEME): LayoutElements {
  const screen = blessed.screen({
    smartCSR: true,
    title: "ReactorTUI — Reactory AI Assistant",
    fullUnicode: true,
    forceUnicode: true,
  });

  // ── Status Bar (top) ─────────────────────────────────────────────────
  const statusBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: {
      fg: theme.text,
      bg: "blue",
    },
    content:
      " {bold}ReactorTUI{/bold} │ No persona selected │ Tokens: 0/— │ ⏸ idle │ ⚡SSE",
  });

  // ── Thinking/Reasoning Panel (collapsible, below status bar) ─────────
  const thinkingPanel = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: "100%",
    height: 0, // starts collapsed
    tags: true,
    border: { type: "line" },
    label: " 💭 Thinking ",
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    style: {
      fg: theme.thinking,
      bg: theme.background,
      border: { fg: theme.muted },
      label: { fg: theme.thinking },
    },
    content: "",
    hidden: true,
  });

  // ── Side Panel (toggleable left/right) ───────────────────────────────
  const sidePanel = blessed.box({
    parent: screen,
    top: 1,
    right: 0,
    width: "30%",
    height: "100%-4",
    border: { type: "line" },
    tags: true,
    style: {
      fg: theme.text,
      bg: theme.background,
      border: { fg: theme.border },
    },
    hidden: true,
  });

  const sidePanelTitle = blessed.box({
    parent: sidePanel,
    top: 0,
    left: 0,
    width: "100%-2",
    height: 1,
    tags: true,
    style: {
      fg: theme.highlight,
      bg: theme.background,
      bold: true,
    },
    content: "",
  });

  const sidePanelContent = blessed.box({
    parent: sidePanel,
    top: 1,
    left: 0,
    width: "100%-2",
    height: "100%-3",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: theme.text,
      bg: theme.background,
    },
    content: "",
  });

  // ── Chat Panel (center) ──────────────────────────────────────────────
  const chatPanel = blessed.log({
    parent: screen,
    top: 1,
    left: 0,
    width: "100%",
    height: "100%-4",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: "│",
      style: { fg: theme.border },
    },
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: theme.text,
      bg: theme.background,
    },
    content: "",
  }) as blessed.Widgets.Log;

  // ── Input Panel (bottom) ─────────────────────────────────────────────
  const inputPanel = blessed.textarea({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: { type: "line" },
    label: " [me]> ",
    inputOnFocus: true,
    keys: true,
    mouse: true,
    tags: true,
    style: {
      fg: theme.text,
      bg: theme.background,
      border: { fg: theme.primary },
      label: { fg: theme.user },
      focus: {
        border: { fg: theme.highlight },
      },
    },
  });

  // ── Help Overlay ─────────────────────────────────────────────────────
  const helpOverlay = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: "80%",
    height: "80%",
    border: { type: "line" },
    label: " Help — Press Escape to close ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: theme.text,
      bg: theme.background,
      border: { fg: theme.primary },
      label: { fg: theme.primary },
    },
    hidden: true,
  });

  // ── Confirm Dialog (for tool approval, delete, etc.) ─────────────────
  const confirmDialog = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: 60,
    height: 10,
    border: { type: "line" },
    label: " Confirm ",
    tags: true,
    style: {
      fg: theme.text,
      bg: theme.background,
      border: { fg: theme.warning },
      label: { fg: theme.warning },
    },
    hidden: true,
  });

  return {
    screen,
    statusBar,
    chatPanel,
    inputPanel,
    sidePanel,
    sidePanelTitle,
    sidePanelContent,
    thinkingPanel,
    helpOverlay,
    confirmDialog,
    spinnerInterval: null,
  };
}

/**
 * Adjust chat panel width when side panel is toggled.
 */
export function adjustChatForSidePanel(
  elements: LayoutElements,
  sidePanelOpen: boolean,
  dock: "left" | "right" = "right"
): void {
  if (sidePanelOpen) {
    elements.chatPanel.width = "70%";
    elements.inputPanel.width = "70%";
    elements.sidePanel.hidden = false;

    if (dock === "left") {
      elements.chatPanel.left = "30%";
      elements.inputPanel.left = "30%";
      elements.sidePanel.left = 0;
      (elements.sidePanel as any).right = undefined;
    } else {
      elements.chatPanel.left = 0;
      elements.inputPanel.left = 0;
      elements.sidePanel.right = 0;
      (elements.sidePanel as any).left = undefined;
    }
  } else {
    elements.chatPanel.width = "100%";
    elements.chatPanel.left = 0;
    elements.inputPanel.width = "100%";
    elements.inputPanel.left = 0;
    elements.sidePanel.hidden = true;
  }
  elements.screen.render();
}

/**
 * Show/hide the thinking panel and adjust chat panel position.
 */
export function adjustThinkingPanel(
  elements: LayoutElements,
  visible: boolean,
  height: number = 6
): void {
  if (visible) {
    elements.thinkingPanel.hidden = false;
    elements.thinkingPanel.height = height;
    elements.chatPanel.top = 1 + height;
    elements.chatPanel.height = `100%-${4 + height}` as any;
  } else {
    elements.thinkingPanel.hidden = true;
    elements.thinkingPanel.height = 0;
    elements.chatPanel.top = 1;
    elements.chatPanel.height = "100%-4" as any;
  }
  elements.screen.render();
}
