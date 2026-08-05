import { promises as fs, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';
import { MacroErrorCode } from '../../errors';

export interface SafeEditFileProps {
  /** The file path to edit */
  path: string;
  /** The search-and-replace patches to apply in order */
  patches: Array<{
    /** The exact block of text to search for */
    search: string;
    /** The block of text to replace it with */
    replace: string;
  }>;
}

export interface SafeEditFileResult {
  success: boolean;
  error?: string;
  errorCode?: MacroErrorCode;
  data?: {
    path: string;
    originalSize: number;
    newSize: number;
    patchesApplied: number;
  };
  tool: string;
  params: SafeEditFileProps;
  metadata?: {
    executionTime: number;
    timestamp: Date;
    user?: string;
  };
}

export const SafeEditFile: Macro<SafeEditFileResult, SafeEditFileProps> = async (
  props: SafeEditFileProps,
  state: ChatState
): Promise<SafeEditFileResult> => {
  const startTime = Date.now();
  const { path: targetPath, patches } = props;

  if (!targetPath) {
    return {
      success: false,
      error: 'No file path provided',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'safeEditFile',
      params: props
    };
  }

  if (!patches || !Array.isArray(patches) || patches.length === 0) {
    return {
      success: false,
      error: 'No patches array provided or array is empty',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'safeEditFile',
      params: props
    };
  }

  try {
    const resolvedPath = targetPath.trim();
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        error: `File not found at path: ${resolvedPath}`,
        errorCode: MacroErrorCode.IO_NOT_FOUND,
        tool: 'safeEditFile',
        params: props
      };
    }

    // 1. Read original file content
    let content = await fs.readFile(resolvedPath, 'utf8');
    const originalSize = Buffer.byteLength(content, 'utf8');

    let patchesApplied = 0;

    // 2. Apply each patch sequentially
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      const searchStr = patch.search;
      const replaceStr = patch.replace;

      if (!searchStr) {
        return {
          success: false,
          error: `Patch at index ${i} is missing 'search' block`,
          errorCode: MacroErrorCode.VALIDATION_INVALID_PARAM,
          tool: 'safeEditFile',
          params: props
        };
      }

      // Check if the search string exists in the content
      if (!content.includes(searchStr)) {
        return {
          success: false,
          error: `Patch at index ${i} failed: The search block was not found in the file. Make sure spelling, whitespace, and line endings match exactly.`,
          errorCode: MacroErrorCode.VALIDATION_INVALID_PARAM,
          tool: 'safeEditFile',
          params: props
        };
      }

      // Perform the replacement (only replace the first occurrence to be extremely safe, or replace all if needed. Replacing first is safer).
      content = content.replace(searchStr, replaceStr);
      patchesApplied++;
    }

    // 3. Write final content to a temporary file (bypassing open process locks on original file)
    const tempPath = `${resolvedPath}.tmp-${Date.now()}`;
    await fs.writeFile(tempPath, content, 'utf8');

    // 4. Verify temp file was written correctly
    const tempContent = await fs.readFile(tempPath, 'utf8');
    if (tempContent !== content) {
      if (existsSync(tempPath)) await fs.unlink(tempPath);
      return {
        success: false,
        error: 'Verification failed: Temp file content does not match intended content.',
        errorCode: MacroErrorCode.IO_READ_WRITE_ERROR,
        tool: 'safeEditFile',
        params: props
      };
    }

    // 5. Atomic swap: rename the temp file over the original file
    // In environments where rename is blocked or across filesystems, copy + unlink is used as fallback.
    try {
      await fs.rename(tempPath, resolvedPath);
    } catch (renameError) {
      // Fallback: copy file and then delete temp file
      await fs.copyFile(tempPath, resolvedPath);
      await fs.unlink(tempPath);
    }

    const newSize = Buffer.byteLength(content, 'utf8');
    const executionTime = Date.now() - startTime;

    logger.info(`SafeEditFile macro executed: ${resolvedPath} successfully edited with ${patchesApplied} patches.`);

    return {
      success: true,
      data: {
        path: resolvedPath,
        originalSize,
        newSize,
        patchesApplied
      },
      tool: 'safeEditFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?._id.toString() || 'unknown'
      }
    };

  } catch (err: any) {
    logger.error(`Error in SafeEditFile macro on ${targetPath}:`, err);
    return {
      success: false,
      error: `Failed to edit file safely: ${err.message}`,
      errorCode: MacroErrorCode.IO_READ_WRITE_ERROR,
      tool: 'safeEditFile',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date()
      }
    };
  }
};

export const SafeEditFileComponentRegister: MacroComponentDefinition<typeof SafeEditFile> = {
  component: SafeEditFile,
  name: 'safeEditFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: 'Safely edits a file by applying search-and-replace patches sequentially. Bypasses locks by writing to a temp file and performing an atomic rename/swap.',
  features: [],
  stem: 'file',
  roles: ['FILE-WRITER-LOCAL', 'DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'edit', 'patch', 'safe'],
  tools: [{
    type: "function",
    function: {
      name: "safeEditFile",
      description: "Safely edits a file by applying search-and-replace patches in order. Bypasses locks by writing to a temp file and performing an atomic swap.",
      icon: "edit",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to edit"
          },
          patches: {
            type: "array",
            description: "The search-and-replace patches to apply in order",
            items: {
              type: "object",
              required: ["search", "replace"],
              properties: {
                search: {
                  type: "string",
                  description: "The exact block of text to search for"
                },
                replace: {
                  type: "string",
                  description: "The block of text to replace it with"
                }
              }
            }
          }
        },
        required: ["path", "patches"]
      }
    }
  }]
};

export default SafeEditFileComponentRegister;
