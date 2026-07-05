import { promises as fs, readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { InsertSnippetProps, InsertSnippetResult } from '../types';
import { MacroErrorCode } from '../../errors';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

const execFileAsync = promisify(execFile);

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
 * content. Returns the trimmed snippet array and the counts of lines
 * removed at each edge so the macro can report them in the structured
 * result — making the silent mutation observable to callers.
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
): { trimmed: string[]; trimStart: number; trimEnd: number } {
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

  if (trimStart === 0 && trimEnd === 0) {
    return { trimmed: snippetLines, trimStart: 0, trimEnd: 0 };
  }

  const trimmed = snippetLines.slice(
    trimStart,
    snippetLines.length - trimEnd,
  );
  logger.info(
    `InsertSnippet: trimmed ${trimStart} leading and ${trimEnd} trailing overlapping lines`,
  );
  return { trimmed, trimStart, trimEnd };
}

/**
 * Check whether any other process currently holds the target file open.
 * Uses `lsof -t -- <path>` on POSIX; skipped on Windows (lsof unavailable).
 * Best-effort: if lsof is missing or errors, we log and allow the write so the
 * macro still works on minimal environments. Mirrors the WriteFile guard.
 */
const checkOpenHandles = async (
  targetPath: string,
): Promise<{ hasOpenHandles: boolean; details?: string }> => {
  if (process.platform === 'win32') {
    return { hasOpenHandles: false };
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '--', targetPath], { timeout: 2000 });
    const ourPid = String(process.pid);
    const pids = stdout
      .trim()
      .split(/\s+/)
      .filter((p) => p && p !== ourPid);
    if (pids.length === 0) return { hasOpenHandles: false };
    return {
      hasOpenHandles: true,
      details: `Open handles held by PIDs: ${pids.join(', ')}`,
    };
  } catch (err) {
    // lsof exits 1 when no results — that means no open handles. Node's
    // child_process sets `.code` to the numeric exit code on non-zero
    // exits, but ErrnoException types it as `string | undefined`, so
    // compare via String() to satisfy both the type system and runtime.
    if (String((err as NodeJS.ErrnoException).code) === '1') {
      return { hasOpenHandles: false };
    }
    logger.warn(`Unable to check open handles for ${targetPath}: ${(err as Error).message}`);
    return { hasOpenHandles: false };
  }
};

const TOOL_NAME = 'insertText';

export const InsertSnippet: Macro<InsertSnippetResult, InsertSnippetProps> = async (
  props: InsertSnippetProps,
  state: ChatState,
): Promise<InsertSnippetResult> => {
  const startTime = Date.now();
  const { path, start, end, snippet, exactMatch } = props;

  // Hoisted so the catch block can report fileExisted accurately even
  // when the throw happens before `targetPath` would otherwise be in
  // scope. Stays `''` until the path-validation guard assigns it.
  let targetPath = '';

  const fail = (
    error: string,
    errorCode: MacroErrorCode,
    operationType: string,
    fileExisted: boolean,
  ): InsertSnippetResult => ({
    success: false,
    error,
    errorCode,
    tool: TOOL_NAME,
    params: props,
    metadata: {
      executionTime: Date.now() - startTime,
      timestamp: new Date(),
      user: state.user?.id,
      fileExisted,
      operationType,
    },
  });

  try {
    if (!path || !path.trim()) {
      return fail('path is required', MacroErrorCode.VALIDATION_REQUIRED_PARAM, 'validation', false);
    }
    if (!start) {
      return fail('start line number is required', MacroErrorCode.VALIDATION_REQUIRED_PARAM, 'validation', false);
    }

    const rawStart = parseInt(start, 10);
    if (isNaN(rawStart) || rawStart < 1) {
      return fail(
        `start must be a positive integer, got "${start}"`,
        MacroErrorCode.VALIDATION_INVALID_PARAM,
        'validation',
        false,
      );
    }

    const startLine = rawStart;
    targetPath = path.trim();
    const fileExisted = existsSync(targetPath);

    if (!fileExisted) {
      return fail(
        `File not found at ${targetPath}`,
        MacroErrorCode.IO_NOT_FOUND,
        'not_found',
        false,
      );
    }

    // Refuse to mutate if another process holds the file open. This is the
    // common cause of "write succeeded but file looks unchanged" — a
    // watcher/editor/formatter either races with us or re-emits the old
    // bytes. Same guard as WriteFile.
    const handleCheck = await checkOpenHandles(targetPath);
    if (handleCheck.hasOpenHandles) {
      return fail(
        `Refusing to edit ${targetPath}: file is held open by another process. ${handleCheck.details}`,
        MacroErrorCode.IO_PERMISSION_DENIED,
        'blocked_open_handles',
        true,
      );
    }

    const data: string = (await fs.readFile(targetPath, 'utf-8')).toString();
    // Normalise line endings to LF so line-number arithmetic is consistent;
    // the original ending style is restored on write.
    const hasCRLF = data.includes('\r\n');
    const normalised = hasCRLF ? data.replace(/\r\n/g, '\n') : data;
    const lines = normalised.split('\n');

    if (startLine > lines.length + 1) {
      return fail(
        `start line ${startLine} is beyond end of file (${lines.length} lines)`,
        MacroErrorCode.VALIDATION_INVALID_PARAM,
        'validation',
        true,
      );
    }
    // `startLine < 1` is already ruled out by the rawStart < 1 guard above;
    // no second check needed here.

    let endLine: number;
    let mode: 'insert' | 'replace';
    if (end) {
      const rawEnd = parseInt(end, 10);
      if (isNaN(rawEnd) || rawEnd < rawStart) {
        return fail(
          `end must be an integer >= start (${rawStart}), got "${end}"`,
          MacroErrorCode.VALIDATION_INVALID_PARAM,
          'validation',
          true,
        );
      }
      endLine = rawEnd;
      mode = 'replace';
      if (endLine > lines.length) {
        return fail(
          `end line ${endLine} is beyond end of file (${lines.length} lines)`,
          MacroErrorCode.VALIDATION_INVALID_PARAM,
          'validation',
          true,
        );
      }
    } else {
      // INSERT mode: no end given — preserve the original line at startLine.
      endLine = startLine - 1;
      mode = 'insert';
    }

    // ── Overlap detection: trim snippet edges that duplicate neighbours ──
    // The `exactMatch` flag bypasses overlap detection entirely. Use it
    // when the snippet's edges legitimately match the neighbouring lines
    // (e.g., a snippet ending with `}` that closes a block, written
    // against a file whose following line is also `}`).
    const snippetLines = snippet.split('\n');
    const linesBefore = lines.slice(0, startLine - 1);
    const linesAfter = lines.slice(endLine);
    const { trimmed: trimmedSnippet, trimStart, trimEnd } = exactMatch
      ? { trimmed: snippetLines, trimStart: 0, trimEnd: 0 }
      : trimOverlap(snippetLines, linesBefore, linesAfter);

    const modifiedLines = [
      ...linesBefore,
      ...trimmedSnippet,
      ...linesAfter,
    ];
    const modifiedData = hasCRLF
      ? modifiedLines.join('\r\n')
      : modifiedLines.join('\n');
    await fs.writeFile(targetPath, modifiedData, 'utf-8');

    // Post-write verification: read the file back and confirm the bytes on
    // disk match what we intended to write. Catches silent failures caused
    // by races with other processes (formatters, watchers) or partial
    // writes. Same guard as WriteFile.
    const writtenBack = await fs.readFile(targetPath, 'utf-8');
    if (writtenBack !== modifiedData) {
      logger.error(
        `InsertSnippet verification failed for ${targetPath}: expected ${modifiedData.length} bytes, got ${writtenBack.length} bytes.`,
      );
      return fail(
        `Write verification failed: on-disk content does not match intended content (expected ${modifiedData.length} bytes, got ${writtenBack.length} bytes). The file may be held open or modified by another process.`,
        MacroErrorCode.IO_READ_WRITE_ERROR,
        'verification_failed',
        true,
      );
    }

    const stats = await fs.stat(targetPath);
    const executionTime = Date.now() - startTime;
    const operationType = mode;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastInsertSnippet = {
      path: targetPath,
      mode,
      operation: operationType,
      startLine,
      endLine,
      trimmedLeading: trimStart,
      trimmedTrailing: trimEnd,
      exactMatch: !!exactMatch,
      totalLines: modifiedLines.length,
      lastModified: stats.mtime,
    };

    logger.info(
      `InsertSnippet macro executed: ${targetPath} by user: ${state.user?.id || 'unknown'}, mode: ${mode}, trimmed leading=${trimStart}, trailing=${trimEnd}`,
    );

    const trimReport =
      trimStart === 0 && trimEnd === 0
        ? ''
        : `\n\n### Overlap trim\n- **Leading lines stripped**: ${trimStart}\n- **Trailing lines stripped**: ${trimEnd}\nIf this trim was wrong (your snippet's edges were legitimate content, not duplicated context), re-run with \`exactMatch: true\`.`;

    return {
      success: true,
      tool: TOOL_NAME,
      params: props,
      data: {
        path: targetPath,
        mode,
        operation: operationType,
        startLine,
        endLine,
        linesBefore: linesBefore.length,
        linesAfter: linesAfter.length,
        snippetLines: snippetLines.length,
        insertedLines: trimmedSnippet.length,
        trimmedLeading: trimStart,
        trimmedTrailing: trimEnd,
        exactMatch: !!exactMatch,
        totalLines: modifiedLines.length,
        size: stats.size,
        sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
      },
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        fileExisted,
        operationType,
      },
      instructions: `
## InsertSnippet Results

Successfully ${mode === 'insert' ? 'inserted snippet before' : 'replaced lines'} ${mode === 'insert' ? `line **${startLine}**` : `**${startLine}**..**${endLine}**`} in **${targetPath}**.

### File Information:
- **Path**: ${targetPath}
- **Mode**: ${mode}
- **Final size**: ${(stats.size / 1024).toFixed(2)}KB
- **Final line count**: ${modifiedLines.length}
- **Execution Time**: ${executionTime}ms${trimReport}

### Important
Line numbers in the file have **changed**. You MUST re-read the file (via \`readFile\` or \`snip\`) before making another \`insertText\` call to get the updated line numbers. Never reuse line numbers from a previous read after an edit.

### Available Data:
- **data.path**: Full file path
- **data.mode**: \`insert\` (no end given) or \`replace\` (start+end given)
- **data.startLine / data.endLine**: Resolved 1-based line range used
- **data.insertedLines**: Lines actually written (after any overlap trim)
- **data.trimmedLeading / data.trimmedTrailing**: Lines stripped from each edge by overlap detection
- **data.exactMatch**: Whether overlap detection was bypassed

### State Variables Available:
- \`lastInsertSnippet\`: Summary of this operation for future reference
      `.trim(),
    };
  } catch (err) {
    logger.error(`Error writing file at ${targetPath || path}:`, err);

    const nodeErr = err as NodeJS.ErrnoException;
    let errorCode = MacroErrorCode.IO_READ_WRITE_ERROR;
    if (nodeErr.code === 'ENOENT') errorCode = MacroErrorCode.IO_NOT_FOUND;
    else if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') errorCode = MacroErrorCode.IO_PERMISSION_DENIED;

    return fail(
      `Failed to edit file at ${targetPath || path}: ${(err as Error).message}`,
      errorCode,
      'error',
      targetPath ? existsSync(targetPath) : false,
    );
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
        "OPTIONAL: Set 'exactMatch' to true when your snippet contains structural boundaries (such as '}', ']', or blank lines) at its very start or end that legitimately belong to the replacement and must not be stripped by the overlap-trimming safety feature.\n" +
        "Returns a structured result { success, data, error, errorCode, metadata, instructions }. Check `data.trimmedLeading` / `data.trimmedTrailing` to see if overlap detection silently stripped any snippet edges; if so and that was wrong, re-run with exactMatch: true.",
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
