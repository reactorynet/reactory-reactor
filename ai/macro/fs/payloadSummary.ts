import { createHash } from 'crypto';

/**
 * Describe a payload WITHOUT repeating it.
 *
 * Why this exists: a macro's result is appended to the conversation as the tool result, so every
 * byte it returns is paid for again in tokens — and, for `writeFile`, also persisted through
 * `state.vars` onto the conversation document. `writeFile` used to echo the payload back **twice**
 * (`params.content` and `data.content`), and `safeEditFile` echoed every `search`/`replace` block.
 * That is pure waste: the caller authored the bytes, so it already has them. Worse, it is
 * unbounded — the result grows with the payload, which is how a large file write could push a
 * session over its context budget (and how `state.vars` could push the conversation document
 * towards the BSON ceiling the Phase 3 migration removed for messages).
 *
 * The replacement is a **digest**: enough to confirm what landed, and to verify it against disk
 * afterwards, at a fixed small cost regardless of payload size.
 *
 * Design notes:
 *  - `sha256` is truncated to 16 hex chars. This is an *identity* check against a re-read of the
 *    file, not a security boundary, so collision resistance beyond that is unnecessary.
 *  - `preview` is whitespace-collapsed and hard-bounded, so a payload of one enormous line (a
 *    minified bundle, a base64 blob) cannot smuggle its size past the bound.
 *  - Field names say `omitted` explicitly. A digest that merely looked like content would be read
 *    as content by a model — the failure mode this file exists to prevent.
 */
export interface PayloadDigest {
  /** Always `true`. Present so a caller cannot mistake this for the payload itself. */
  omitted: true;
  /** Length in characters. */
  chars: number;
  /** Length in UTF-8 bytes. */
  bytes: number;
  /** Line count (`0` for an empty payload). */
  lines: number;
  /** Truncated SHA-256 of the payload, for identity checks against a re-read. */
  sha256: string;
  /** How many characters `preview` holds. */
  previewChars: number;
  /** Whitespace-collapsed head of the payload. */
  preview: string;
}

export interface DigestOptions {
  /** Maximum preview characters. Default 160. */
  previewChars?: number;
  /** Show the tail instead of the head — useful for append/prepend. Default false. */
  tail?: boolean;
}

const DEFAULT_PREVIEW_CHARS = 160;

/** Coerce anything to the string form whose digest is meaningful. */
const asText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

/** Build a digest of `value`. Never throws; a payload that cannot be serialised is described. */
export const digestPayload = (value: unknown, options: DigestOptions = {}): PayloadDigest => {
  const text = asText(value);
  const previewChars = Math.max(0, options.previewChars ?? DEFAULT_PREVIEW_CHARS);
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

  const source = options.tail ? text.slice(-previewChars) : text.slice(0, previewChars);
  const preview = source.replace(/\s+/g, ' ').trim();

  return {
    omitted: true,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines,
    sha256,
    previewChars: preview.length,
    preview,
  };
};

/**
 * Render a digest as a one-line, human- and model-readable string.
 *
 * Separate from `summarisePayload` so a caller that needs the digest object anyway (to publish
 * `contentDigest`) hashes the payload **once** rather than once per representation. Kept
 * deliberately short so it can stand in for the payload in `params` or `data.content`.
 */
export const describeDigest = (digest: PayloadDigest, label = 'payload'): string => {
  if (digest.chars === 0) return `[${label}: empty]`;

  const elided = digest.previewChars < digest.chars ? '…' : '';
  return (
    `[${label} omitted from this result: ${digest.chars} chars, ${digest.bytes} bytes, ` +
    `${digest.lines} line(s), sha256:${digest.sha256}] ` +
    `preview: "${digest.preview}${elided}"`
  );
};

/**
 * One-line form of a digest, for a field whose type must stay `string`.
 *
 * Convenience wrapper over `digestPayload` + `describeDigest` for callers that only need the
 * string.
 */
export const summarisePayload = (
  value: unknown,
  label = 'payload',
  options: DigestOptions = {}
): string => describeDigest(digestPayload(value, options), label);
