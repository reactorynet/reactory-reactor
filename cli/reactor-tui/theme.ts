/**
 * Terminal color theme for ReactorTUI.
 * Maps semantic roles to blessed-compatible color strings.
 */
import { TUITheme } from "./types";

export const DEFAULT_THEME: TUITheme = {
  primary: "cyan",
  secondary: "magenta",
  background: "black",
  text: "white",
  muted: "gray",
  error: "red",
  warning: "yellow",
  success: "green",
  info: "blue",
  user: "cyan",
  assistant: "green",
  system: "gray",
  tool: "yellow",
  thinking: "gray",
  border: "blue",
  highlight: "white",
};

/**
 * Token pressure color thresholds — mirrors ReactorChat.tsx getTokenPressureColor.
 */
export function getTokenPressureColor(pressure: number): string {
  if (pressure <= 0.25) return "green";
  if (pressure <= 0.5) return "yellow";
  if (pressure <= 0.75) return "red";
  return "red";
}

/**
 * Role-to-color mapping for chat messages.
 */
export function getMessageColor(
  role: string,
  theme: TUITheme = DEFAULT_THEME
): string {
  switch (role) {
    case "user":
      return theme.user;
    case "assistant":
      return theme.assistant;
    case "system":
      return theme.system;
    case "tool":
      return theme.tool;
    case "error":
      return theme.error;
    default:
      return theme.text;
  }
}

/**
 * Network status indicator symbols.
 */
export function getNetworkStatusIndicator(
  status: string,
  attempt?: number
): string {
  switch (status) {
    case "idle":
      return "{gray-fg}⏸{/gray-fg}";
    case "connected":
      return "{green-fg}●{/green-fg}";
    case "reconnecting":
      return `{yellow-fg}↻ ${attempt || ""}⧸5{/yellow-fg}`;
    case "error":
      return "{red-fg}✖{/red-fg}";
    default:
      return "{gray-fg}?{/gray-fg}";
  }
}

/**
 * Streaming mode indicator.
 */
export function getStreamingIndicator(enabled: boolean): string {
  return enabled
    ? "{green-fg}⚡SSE{/green-fg}"
    : "{gray-fg}⏎ GQL{/gray-fg}";
}

/**
 * Voice mode indicator.
 */
export function getVoiceIndicator(
  active: boolean,
  subState?: "recording" | "playing" | "idle"
): string {
  if (!active) return "";
  switch (subState) {
    case "recording":
      return "{red-fg}🎤{/red-fg}";
    case "playing":
      return "{green-fg}🔊{/green-fg}";
    default:
      return "{cyan-fg}🎧{/cyan-fg}";
  }
}
