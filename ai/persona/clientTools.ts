/**
 * Tool names that are advertised by the CLIENT, never registered on the server.
 *
 * Client tools have no server-side execution path: the browser mounts the
 * component and reports the result back. The client advertises these tools at
 * session creation via `ReactorConversationService.syncClientCapabilities`, and
 * the server records them as `runat: 'client'`.
 *
 * They deliberately have no `MacroRegistry` entry — and must not gain one. The
 * server cannot execute them, so a registry entry would only create the false
 * impression that a static server-side registration is required. Persona
 * `*_TOOL_INCLUDES` lists are matched against `MacroRegistry`, so naming any of
 * these there is a no-op that reads as if it did something.
 *
 * See `ReactorConversationService.clientTools.test.ts` and
 * `ImageToolProviderResolution.test.ts` for the contract.
 */
export const CLIENT_ADVERTISED_TOOL_NAMES: readonly string[] = [
  'form',
  'component',
  'chart',
  'd3',
  'image',
];

export default CLIENT_ADVERTISED_TOOL_NAMES;
