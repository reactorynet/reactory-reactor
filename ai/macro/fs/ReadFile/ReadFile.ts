import os from 'os';
import pathModule from 'path';
import { promises as fs, readFileSync, existsSync } from 'fs';
import logger from '@reactory/server-core/logging';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { ReadFileProps, ReadFileResult } from '../types';
import { MacroErrorCode } from '../../errors';

export const ReadFile: Macro<ReadFileResult, ReadFileProps> = async (
  props: ReadFileProps,
  state: ChatState): Promise<ReadFileResult> => {
  const { path, id } = props;
  let targetPath = path?.trim();
  
  if (!targetPath) {
    return {
      success: false,
      error: 'No path provided',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'readFile',
      params: props
    };
  }

  // Security: Normalize path first, then check for traversal
  if (targetPath.startsWith("~")) targetPath = targetPath.replace("~", os.homedir());
  
  const WORKING_FOLDER = process.cwd();
  const HOME_FOLDER = os.homedir();
  
  // Resolve relative paths against the working folder
  if (!pathModule.isAbsolute(targetPath)) {
    targetPath = pathModule.resolve(WORKING_FOLDER, targetPath);
  }
  
  // Normalize to remove any ./ or ../ segments
  targetPath = pathModule.normalize(targetPath);
  
  // Security: Reject path traversal after normalization
  if (targetPath.includes('..')) {
    return {
      success: false,
      error: 'Operation not allowed. Path traversal detected.',
      errorCode: MacroErrorCode.IO_PATH_TRAVERSAL,
      tool: 'readFile',
      params: props
    };
  }
  
  // Resolve symlinks to get the real path, preventing symlink-based traversal
  if (existsSync(targetPath)) {
    try {
      const realPath = await fs.realpath(targetPath);
      targetPath = realPath;
    } catch {
      // If realpath fails, continue with the normalized path
    }
  }
  
  if (!targetPath.startsWith(HOME_FOLDER)) {
    return {
      success: false,
      error: 'Operation not allowed. You can only read files in your home directory',
      errorCode: MacroErrorCode.IO_PERMISSION_DENIED,
      tool: 'readFile',
      params: props
    };
  }

  try {
    // Check if file exists
    if (!existsSync(targetPath)) {
      return {
        success: false,
        error: `File not found: ${targetPath}`,
        errorCode: MacroErrorCode.IO_NOT_FOUND,
        tool: 'readFile',
        params: props
      };
    }

    // Get file stats for metadata
    const stats = await fs.stat(targetPath);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
    
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large. Maximum size is 10MB. File size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`,
        tool: 'readFile',
        params: props
      };
    }

    // Read file content
    const data = (await fs.readFile(targetPath, 'utf-8')).toString();
    const mime = targetPath.split('.').pop() || 'txt';
    const idAttribute = id ? ` id="${id}"` : '';
    
    // Create markdown code block
    const codeBlock = `\`\`\`${mime}${idAttribute}\n${data.toString()}\n\`\`\``;

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastReadFile = {
      path: targetPath,
      content: data,
      size: stats.size,
      mimeType: mime,
      lastModified: stats.mtime
    };

    // Log access for security
    logger.info(`ReadFile macro accessed: ${targetPath} by user: ${state.user?.id || 'unknown'}`);

    return {
      success: true,
      data: {
        content: data,
        codeBlock: codeBlock,
        metadata: {
          path: targetPath,
          size: stats.size,
          sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
          mimeType: mime,
          lastModified: stats.mtime,
          created: stats.birthtime
        }
      },
      tool: 'readFile',
      params: props,
      instructions: `
## File Read Results

Successfully read file: **${pathModule.basename(targetPath)}**

### File Information:
- **Path**: ${targetPath}
- **Size**: ${(stats.size / 1024).toFixed(2)}KB
- **Type**: ${mime}
- **Last Modified**: ${stats.mtime.toISOString()}

### Available Data:
- **content**: Raw file content as string
- **codeBlock**: Formatted markdown code block with syntax highlighting
- **metadata**: File statistics and properties

### State Variables Available:
- lastReadFile: Complete file information for future reference

### Usage:
- Use the \`content\` field for text processing or analysis
- Use the \`codeBlock\` field for display in chat responses
- Use \`metadata\` for file information and validation
      `
    };

  } catch (err) {
    logger.error(`Error reading file at ${targetPath}:`, err);
    return {
      success: false,
      error: `Failed to read file: ${err.message}`,
      tool: 'readFile',
      params: props
    };
  }
};

export const ReadFileComponentRegister: MacroComponentDefinition<typeof ReadFile> = {
  component: ReadFile,
  name: 'readFile',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  roles: ['DEVELOPER', 'ADMIN'],
  stem: 'file',
  tags: ['macro', 'file', 'read'],
  tools: [{
    type: "function",
    function: {
      name: "readFile",
      description: "Reads a file and returns its content with metadata in a structured format for AI processing",
      icon: "description",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to read"
          },
          id: {
            type: "string",
            description: "Optional ID for the code block"
          }
        },
        required: ["path"]
      }
    }
  }]
};
