/**
 * Runtime-mode detection for MCP flows.
 *
 * "Local mode" means Reactory is running on the user's own machine (the wrapped
 * electron desktop shell or an explicit local install). In that mode an OAuth
 * redirect to `localhost` works and the system browser can be opened, so the
 * consent flow can be near-seamless. In server mode consent must happen
 * out-of-band (the macro surfaces an authorization URL).
 *
 * The canonical existing signal is `IS_DESKTOP_INSTALL`; `IS_LOCAL_MODE` is
 * accepted as an alias, and the electron runtime is always treated as local.
 */
export const isLocalMode = (): boolean =>
  process.env.IS_LOCAL_MODE === "true" ||
  process.env.IS_DESKTOP_INSTALL === "true" ||
  !!(process.versions as Record<string, string | undefined>).electron;
