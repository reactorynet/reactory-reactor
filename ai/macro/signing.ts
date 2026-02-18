/**
 * Request signing and verification for macro execution.
 *
 * Provides HMAC-based signing so that macro calls arriving from
 * external sources (MCP, GraphQL mutations, webhooks) can be verified
 * as originating from the Reactor system.
 *
 * Usage:
 *   import { signMacroRequest, verifyMacroRequest } from './signing';
 *
 *   // Signing side
 *   const signature = signMacroRequest({ macro: 'ReadFile', params: {...}, userId: '...' });
 *
 *   // Verification side
 *   const valid = verifyMacroRequest(payload, signature);
 */
import crypto from 'crypto';

/**
 * Payload fields used for signing.
 * The caller can include any combination; all present fields are
 * sorted and serialized deterministically.
 */
export interface MacroRequestPayload {
  /** Macro or tool name */
  macro: string;
  /** Serializable parameters */
  params?: unknown;
  /** Requesting user id */
  userId?: string;
  /** ISO timestamp of the request */
  timestamp?: string;
  /** Chat session or conversation id */
  sessionId?: string;
}

/** The signing secret. Falls back to a generated random key per-process if not set. */
const SIGNING_SECRET: string =
  process.env.REACTOR_MACRO_SIGNING_SECRET ||
  crypto.randomBytes(32).toString('hex');

/** Maximum age (ms) of a signed request before it is considered expired. Default: 5 min. */
const MAX_AGE_MS = Number(process.env.REACTOR_MACRO_SIGN_MAX_AGE_MS) || 5 * 60 * 1000;

/**
 * Produce a canonical string from a payload by sorting keys and
 * JSON-stringifying the values.
 */
function canonicalize(payload: MacroRequestPayload): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(payload).sort()) {
    const val = (payload as any)[key];
    ordered[key] = typeof val === 'string' ? val : JSON.stringify(val);
  }
  return JSON.stringify(ordered);
}

/**
 * Sign a macro request payload.
 *
 * @returns An HMAC-SHA256 hex digest that can be passed alongside the request.
 */
export function signMacroRequest(payload: MacroRequestPayload): string {
  const canonical = canonicalize(payload);
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(canonical)
    .digest('hex');
}

/**
 * Verify that a macro request's signature is valid and not expired.
 *
 * @param payload   The same payload that was signed.
 * @param signature The hex signature to verify.
 * @returns `true` if the signature matches and the timestamp (if present) is within `MAX_AGE_MS`.
 */
export function verifyMacroRequest(
  payload: MacroRequestPayload,
  signature: string
): boolean {
  // Timestamp freshness check
  if (payload.timestamp) {
    const requestTime = new Date(payload.timestamp).getTime();
    if (isNaN(requestTime)) return false;
    if (Math.abs(Date.now() - requestTime) > MAX_AGE_MS) return false;
  }

  const expected = signMacroRequest(payload);
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature, 'hex')
  );
}
