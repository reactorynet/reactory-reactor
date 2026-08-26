/**
 * Origin used when minting SSE endpoint URLs for the browser.
 *
 * Browsers pool HTTP/1.1 connections per **origin** (scheme + host + port) and
 * allow only six. An SSE stream holds one of those open for its entire life, so
 * every stream served from the API's own origin is a socket permanently removed
 * from the budget that GraphQL, the CDN and every other REST call share. Three
 * live streams on a same-origin CDN (the default `REACT_APP_CDN` points at
 * `<api>/cdn`) is enough to leave GraphQL requests queued indefinitely — which
 * presents as "the server stopped responding" while the server is in fact idle.
 *
 * Setting `SSE_URI_ROOT` to a *different* origin for the same server gives the
 * streams their own six-socket pool and takes them out of everything else's way.
 * Because the browser keys the pool on the literal host string, an alias of the
 * same machine is enough — `http://127.0.0.1:4000` against an API on
 * `http://localhost:4000` are two origins as far as Chrome is concerned, so this
 * needs no extra listener, proxy or certificate.
 *
 * The proper fix is HTTP/2 on the API, which multiplexes and removes the limit
 * altogether; this is the zero-infrastructure stand-in until then.
 *
 * Falls back to `API_URI_ROOT`, so leaving it unset keeps the previous
 * behaviour exactly.
 */
export const sseUriRoot = (): string =>
  process.env.SSE_URI_ROOT || process.env.API_URI_ROOT || 'http://localhost:4000';

export default sseUriRoot;
