/**
 * Utilities for summarizing/truncating large macro outputs.
 *
 * When a data macro or ListDirectory produces a very large result set,
 * the full output can overwhelm the AI context window. These helpers
 * provide a consistent way to cap output size while preserving enough
 * information for the AI to respond usefully.
 */

/** Default maximum number of items to include in a result before truncating */
export const DEFAULT_MAX_ITEMS = 200;

/** Default maximum character length for formatted output */
export const DEFAULT_MAX_OUTPUT_LENGTH = 50_000;

/**
 * Summarize configuration for controlling output size
 */
export interface SummarizeOptions {
  /** Maximum items to include (default: 200) */
  maxItems?: number;
  /** Maximum formatted output char length (default: 50000) */
  maxOutputLength?: number;
}

export interface SummarizedResult<T> {
  /** The (possibly truncated) items */
  items: T[];
  /** Total count of items before truncation */
  totalCount: number;
  /** Count of items after truncation */
  returnedCount: number;
  /** True if the result was truncated */
  truncated: boolean;
  /** Human-readable summary string */
  summary: string;
}

/**
 * Truncate an array of items and produce a summary.
 *
 * @param items   Full result set
 * @param options Truncation options
 * @returns A `SummarizedResult` with metadata about truncation
 */
export function summarizeItems<T>(
  items: T[],
  options: SummarizeOptions = {}
): SummarizedResult<T> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const totalCount = items.length;
  const truncated = totalCount > maxItems;
  const returnedItems = truncated ? items.slice(0, maxItems) : items;

  const summary = truncated
    ? `Showing ${returnedItems.length} of ${totalCount} items (truncated). Use filter/limit params to narrow results.`
    : `Showing all ${totalCount} items.`;

  return {
    items: returnedItems,
    totalCount,
    returnedCount: returnedItems.length,
    truncated,
    summary,
  };
}

/**
 * Truncate a formatted output string if it exceeds maxOutputLength.
 *
 * @param output  The full formatted string
 * @param options Truncation options
 * @returns The (possibly truncated) string with a notice appended
 */
export function truncateOutput(
  output: string,
  options: SummarizeOptions = {}
): string {
  const maxLen = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
  if (output.length <= maxLen) return output;
  return (
    output.slice(0, maxLen) +
    `\n\n--- Output truncated (${output.length} chars → ${maxLen} chars). Use filter/limit params to narrow results. ---`
  );
}
