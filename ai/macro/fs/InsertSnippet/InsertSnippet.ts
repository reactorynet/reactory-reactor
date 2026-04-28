import { promises as fs, readFileSync } from 'fs';
import { InsertSnippetProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

/**
 * A line is "structural" when it carries no semantic content of its own —
 * blank lines, lone closers (`}`, `]`, `)`), and trailing-comma/-semicolon
 * variants. These lines match each other across unrelated scopes and were
 * the root cause of the false-positive trim bug in the original
 * implementation: a snippet ending with `  }` against a file whose next
 * line was also `  }` would have its closing brace silently stripped.
 */
export function isStructuralLine(line: string): boolean {
  // Empty / whitespace-only.
  if (!line || /^\s*$/.test(line)) return true;
  // Lone closers, optionally followed by `;` or `,`, optionally preceded
  // by indentation. e.g. `}`, `  }`, `})`, `})`, `});`, `],`, `  ));`.
  return /^\s*[\]})]+\s*[;,]?\s*$/.test(line);
}

/**
 * Trims leading and trailing snippet lines that duplicate adjacent file
 * content. Returns a new snippet array (may be unchanged).
 *
 * Refinement (per InsertSnippet_Fix_Spec): a candidate trim is rejected
 * when ALL of its lines are "structural" (blank, or lone closing brace
 * variants). This prevents the common false positive where a snippet
 * ending in `}` was mistakenly matched against a parent scope's closing
 * `}`, which previously caused brace-strip corruption of the output.
 *
 * Callers wanting to bypass overlap detection entirely should set
 * `props.exactMatch: true` on the macro args; that path skips this
 * function altogether.
 */
function trimOverlap(
  snippetLines: string[],
  linesBefore: string[],
  linesAfter: string[],
): string[] {
  // Find longest prefix of snippetLines matching a suffix of linesBefore
  let trimStart = 0;
  const maxLeading = Math.min(snippetLines.length, linesBefore.length);
  for (let len = maxLeading; len >= 1; len--) {
    let match = true;
    for (let i = 0; i < len; i++) {
      if (snippetLines[i] !== linesBefore[linesBefore.length - len + i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Structural-only safety: don't trim a candidate that's purely
      // closers/blanks. Such a match is far more likely a coincidence
      // than a duplicated context block. Continue scanning shorter
      // candidates in case a non-structural shorter prefix matches.
      const candidate = snippetLines.slice(0, len);
      if (candidate.every(isStructuralLine)) {
        continue;
      }
      trimStart = len;
      break;
    }
  }

  // Find longest suffix of remaining snippetLines matching a prefix of linesAfter
  let trimEnd = 0;
  const remaining = snippetLines.length - trimStart;
  const maxTrailing = Math.min(remaining, linesAfter.length);
  for (let len = maxTrailing; len >= 1; len--) {
    const offset = snippetLines.length - len;
    let match = true;
    for (let i = 0; i < len; i++) {
      if (snippetLines[offset + i] !== linesAfter[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const candidate = snippetLines.slice(offset, offset + len);
      if (candidate.every(isStructuralLine)) {
        continue;
      }
      trimEnd = len;
      break;
    }
  }

  if (trimStart === 0 && trimEnd === 0) return snippetLines;

  const trimmed = snippetLines.slice(
    trimStart,
    snippetLines.length - trimEnd,
  );
  logger.info(
    `InsertSnippet: trimmed ${trimStart} leading and ${trimEnd} trailing overlapping lines`,
  );
  return trimmed;
}

export const InsertSnippet: Macro<string, InsertSnippetProps> = async (
  props: InsertSnippetProps,
  state: ChatState
) => {
  const { path, start, end, snippet, exactMatch } = props;
  try {
    if (!path || !path.trim()) {
      return 'Error: path is required';
    }
    if (!start) {
      return 'Error: start line number is required';
    }

    const rawStart = parseInt(start, 10);
    if (isNaN(rawStart) || rawStart < 1) {
      return `Error: start must be a positive integer, got "${start}"`;
    }

    const startLine = rawStart;

    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    // Normalise line endings to LF so line-number arithmetic is consistent;
    // the original ending style is restored on write.
    const hasCRLF = data.includes('\r\n');
    const normalised = hasCRLF ? data.replace(/\r\n/g, '\n') : data;
    const lines = normalised.split('\n');

    if (startLine > lines.length + 1) {
      return `Error: start line ${startLine} is beyond end of file (${lines.length} lines)`;
    }
    if (startLine < 1) {
      return `Error: start line ${startLine} is before beginning of file`;
    }

    let endLine: number;
    if (end) {
      const rawEnd = parseInt(end, 10);
      if (isNaN(rawEnd) || rawEnd < rawStart) {
        return `Error: end must be an integer >= start (${rawStart}), got "${end}"`;
      }
      endLine = rawEnd;
      if (endLine > lines.length) {
        return `Error: end line ${endLine} is beyond end of file (${lines.length} lines)`;
      }
    } else {
      // INSERT mode: no end given — preserve the original line at startLine.
      endLine = startLine - 1;
    }

    // ── Overlap detection: trim snippet edges that duplicate neighbours ──
    // The `exactMatch` flag bypasses overlap detection entirely. Use it
    // when the snippet's edges legitimately match the neighbouring lines
    // (e.g., a snippet ending with `}` that closes a block, written
    // against a file whose following line is also `}`).
    const snippetLines = snippet.split('\n');
    const linesBefore = lines.slice(0, startLine - 1);
    const linesAfter = lines.slice(endLine);
    const trimmedSnippet = exactMatch
      ? snippetLines
      : trimOverlap(snippetLines, linesBefore, linesAfter);

    const modifiedLines = [
      ...linesBefore,
      ...trimmedSnippet,
      ...linesAfter,
    ];
    const modifiedData = hasCRLF
      ? modifiedLines.join('\r\n')
      : modifiedLines.join('\n');
    await fs.writeFile(path.trim(), modifiedData, 'utf-8');

    return `Snippet inserted into ${path} successfully. The file now has ${modifiedLines.length} lines. Re-read the file before making further edits.`;
  } catch (err) {
    logger.error(`Error writing file at ${path}:`, err);
    return `Error writing file at ${path}`;
  }
};

const readmeText = readFileSync(require.resolve('./readme.md'), 'utf-8').toString();

export const InsertSnippetComponentRegister: MacroComponentDefinition<typeof InsertSnippet> = {
  component: InsertSnippet,
  name: 'insertText',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readmeText,
  features: [],
  stem: 'insertText',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'insert', 'snippet', 'replace', 'insert'],
  tools: [{
    type: "function",
    function: {
      name: "insertText",
      description:
        "Inserts or replaces text in a file at specified line positions.\n" +
        "INSERT mode: when only 'start' is provided the snippet is inserted BEFORE that line; the original line and all lines after it are preserved automatically.\n" +
        "REPLACE mode: when both 'start' and 'end' are provided the lines in [start, end] are replaced by the snippet; lines BEFORE start and AFTER end are preserved automatically.\n" +
        "IMPORTANT: The snippet must contain ONLY the new/replacement content. Do NOT include context lines that already exist before start or after end — they are kept automatically and including them causes duplication.\n" +
        "IMPORTANT: After each insertText call, line numbers in the file CHANGE. You MUST re-read the file (via snip or readFile) before making another insertText call to get the updated line numbers. Never reuse line numbers from a previous read after an edit.\n" +
        "OPTIONAL: Set 'exactMatch' to true when your snippet contains structural boundaries (such as '}', ']', or blank lines) at its very start or end that legitimately belong to the replacement and must not be stripped by the overlap-trimming safety feature.",
      icon: "content_paste",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to modify"
          },
          start: {
            type: "string",
            description: "Start line number (1-based). MUST match the current file state — re-read the file after any previous insertText call to get correct line numbers."
          },
          end: {
            type: "string",
            description: "End line number (1-based, inclusive, optional). When provided, lines [start..end] are replaced. Omit to insert before 'start' without removing any lines. Must match current file state."
          },
          snippet: {
            type: "string",
            description: "The exact replacement or insertion text. Must contain ONLY new content — do NOT repeat lines that already exist before 'start' or after 'end'."
          },
          exactMatch: {
            type: "boolean",
            description: "If true, disables the automatic overlap-trimming safety feature. Set to true when your snippet contains structural boundaries (like '}', ']', or blank lines) at its very start or end that legitimately match the surrounding lines and must not be stripped. Default: false."
          }
        },
        required: ["path", "start", "snippet"]
      }
    }
  }],
};
