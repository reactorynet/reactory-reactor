import { promises as fs, readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WriteFileProps, WriteFileResult } from '../types';
import { MacroErrorCode } from '../../errors';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

const execFileAsync = promisify(execFile);
const CONTENT_BLOCK_REGEX = /(```?.+?)\n([\s\S]+?)\n```/g;

/**
 * Check whether any other process currently holds the target file open.
 * Uses `lsof -t -- <path>` on POSIX; skipped on Windows (lsof unavailable).
 * Best-effort: if lsof is missing or errors, we log and allow the write so the
 * macro still works on minimal environments.
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
    // lsof exits 1 when no results — that means no open handles.
    if ((err as NodeJS.ErrnoException).code === 1) {
      return { hasOpenHandles: false };
    }
    logger.warn(`Unable to check open handles for ${targetPath}: ${(err as Error).message}`);
    return { hasOpenHandles: false };
  }
};

export const WriteFile: Macro<WriteFileResult, WriteFileProps> = async (
  props: WriteFileProps,
  state: ChatState): Promise<WriteFileResult> => {
  const startTime = Date.now();
  const {
    path,
    content,
    mode = 'overwrite',
    start = 0, 
    end = -1
  } = props;

  if (!path) {
    return {
      success: false,
      error: 'No path provided',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'writeFile',
      params: props
    };
  }

  if (!content) {
    return {
      success: false,
      error: 'No content was provided',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'writeFile',
      params: props
    };
  }

  try {
    const targetPath = path.trim();
    const fileExisted = existsSync(targetPath);
    let finalContent = content;
    let operationType = 'write';

    // Unwrap a code fence ONLY when the entire payload is a single complete
    // fenced block (i.e. the AI wrapped its whole response in ``` ... ```).
    // Do NOT strip fences that appear inside a larger document — that silently
    // dropped everything outside the fence and corrupted markdown payloads that
    // embed code blocks. The regex match must span the full trimmed content for
    // us to treat this as a "wrapped" payload.
    if (content.indexOf('```') !== -1) {
      const trimmed = content.trim();
      if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
        const matches = [...trimmed.matchAll(CONTENT_BLOCK_REGEX)];
        if (matches.length === 1 && matches[0][0].length === trimmed.length) {
          finalContent = matches[0][2];
        } else {
          logger.info(
            `WriteFile: payload for ${targetPath} contains fenced code block(s) but is not a single wrapping fence — writing verbatim.`
          );
        }
      }
    }

    // Handle different write modes
    if (fileExisted && mode === 'create') {
      return {
        success: false,
        error: 'File already exists and overwrite is set to false',
        errorCode: MacroErrorCode.VALIDATION_INVALID_PARAM,
        tool: 'writeFile',
        params: props
      };
    }

    // For any mutation of an existing file, refuse if another process holds it open.
    // This is the common cause of "write succeeded but file looks unchanged" — a
    // watcher/editor/formatter either races with us or re-emits the old bytes.
    if (fileExisted && (mode === 'overwrite' || mode === 'append' || mode === 'prepend' || mode === 'insert')) {
      const handleCheck = await checkOpenHandles(targetPath);
      if (handleCheck.hasOpenHandles) {
        return {
          success: false,
          error: `Refusing to ${mode} ${targetPath}: file is held open by another process. ${handleCheck.details}`,
          errorCode: MacroErrorCode.IO_PERMISSION_DENIED,
          tool: 'writeFile',
          params: props,
          metadata: {
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
            user: state.user?.id,
            fileExisted,
            operationType: 'blocked_open_handles'
          }
        };
      }
    }

    if (fileExisted && mode === 'overwrite') {
      operationType = 'overwrite';
    }

    if (fileExisted && mode === 'append') {
      const existingContent = (await fs.readFile(targetPath, 'utf-8')).toString();
      finalContent = `${existingContent}\n${finalContent.trim()}`;
      operationType = 'append';
    }

    if (fileExisted && mode === 'prepend') {
      const existingContent = (await fs.readFile(targetPath, 'utf-8')).toString();
      finalContent = `${finalContent.trim()}\n${existingContent}`;
      operationType = 'prepend';
    }

    if (fileExisted && mode === 'insert') {
      const lines = finalContent.split('\n');
      const existing = (await fs.readFile(targetPath, 'utf-8')).toString().split('\n');
      const startLine = Number(start);
      const endLine = Number(end);

      if (endLine < startLine) {
        return {
          success: false,
          error: 'Invalid start and end line parameters',
          errorCode: MacroErrorCode.VALIDATION_INVALID_PARAM,
          tool: 'writeFile',
          params: props
        };
      }

      const modifiedLines = [
        ...existing.slice(0, startLine - 1),
        ...lines,
        ...existing.slice(endLine)
      ];
      finalContent = modifiedLines.join('\n');
      operationType = 'insert';
    }

    // Write the file verbatim — no trimming. Trimming here would silently alter
    // the bytes the caller asked us to write, making verbatim verification
    // impossible and producing "wrote successfully but file unchanged" bugs when
    // the only difference between new and existing content was whitespace.
    await fs.writeFile(targetPath, finalContent, 'utf-8');

    // Post-write verification: read the file back and confirm the bytes on disk
    // match exactly what we intended to write. Catches silent failures caused by
    // races with other processes (formatters, watchers) or partial writes.
    const writtenBack = await fs.readFile(targetPath, 'utf-8');
    if (writtenBack !== finalContent) {
      logger.error(
        `WriteFile verification failed for ${targetPath}: expected ${finalContent.length} bytes, got ${writtenBack.length} bytes.`
      );
      return {
        success: false,
        error: `Write verification failed: on-disk content does not match intended content (expected ${finalContent.length} bytes, got ${writtenBack.length} bytes). The file may be held open or modified by another process.`,
        errorCode: MacroErrorCode.IO_READ_WRITE_ERROR,
        tool: 'writeFile',
        params: props,
        metadata: {
          executionTime: Date.now() - startTime,
          timestamp: new Date(),
          user: state.user?.id,
          fileExisted,
          operationType: 'verification_failed'
        }
      };
    }

    // Get file stats for metadata
    const stats = await fs.stat(targetPath);
    const executionTime = Date.now() - startTime;

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastWriteFile = {
      path: targetPath,
      content: finalContent,
      size: stats.size,
      mode: mode,
      operation: operationType,
      lastModified: stats.mtime
    };

    // Log operation for security
    logger.info(`WriteFile macro executed: ${targetPath} by user: ${state.user?.id || 'unknown'}, mode: ${mode}`);

    return {
      success: true,
      data: {
        path: targetPath,
        content: finalContent,
        mode: mode,
        size: stats.size,
        sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
        operation: operationType
      },
      tool: 'writeFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        fileExisted,
        operationType
      },
      instructions: `
## File Write Results

Successfully ${operationType} file: **${targetPath}**

### File Information:
- **Path**: ${targetPath}
- **Size**: ${(stats.size / 1024).toFixed(2)}KB
- **Mode**: ${mode}
- **Operation**: ${operationType}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **path**: Full file path
- **content**: Written content (may be truncated for large files)
- **mode**: Write mode used
- **size**: File size in bytes
- **operation**: Type of operation performed

### State Variables Available:
- lastWriteFile: Complete file information for future reference

### Usage:
- Use the \`content\` field to verify what was written
- Use \`metadata\` for operation details and timing
- Use \`data\` for file information and validation
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error writing file at ${path}:`, err);

    const nodeErr = err as NodeJS.ErrnoException;
    let errorCode = MacroErrorCode.IO_READ_WRITE_ERROR;
    if (nodeErr.code === 'ENOENT') errorCode = MacroErrorCode.IO_NOT_FOUND;
    else if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') errorCode = MacroErrorCode.IO_PERMISSION_DENIED;

    return {
      success: false,
      error: `Failed to write file: ${(err as Error).message}`,
      errorCode,
      tool: 'writeFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        fileExisted: false,
        operationType: 'error'
      }
    };
  }
}

export const WriteFileComponentRegister: MacroComponentDefinition<typeof WriteFile> = {
  component: WriteFile,
  name: 'writeFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  roles: ['FILE-WRITER-LOCAL', 'DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'write', 'save', 'output'],
  tools: [{
    type: "function",
    function: {
      name: "writeFile",
      description: "Writes content to a file with different modes and returns structured results",
      icon: "save",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to write to"
          },
          content: {
            type: "string",
            description: "The content to write"
          },
          mode: {
            type: "string",
            enum: ["overwrite", "create", "append", "prepend", "insert"],
            description: "Write mode"
          },
          start: {
            type: "number",
            description: "Start line number for insert mode (1-based)"
          },
          end: {
            type: "number",
            description: "End line number for insert mode (1-based)"
          }
        },
        required: ["path", "content"]
      }
    }
  }]
}
