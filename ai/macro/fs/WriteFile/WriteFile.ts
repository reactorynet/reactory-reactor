import { promises as fs, readFileSync, existsSync } from 'fs';
import { WriteFileProps, WriteFileResult } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

const CONTENT_BLOCK_REGEX = /(```?.+?)\n([\s\S]+?)\n```/g;

export const WriteFile: Macro<WriteFileResult, WriteFileProps> = async (
  props: WriteFileProps,
  state: ChatState): Promise<WriteFileResult> => {
  const startTime = Date.now();
  const {
    path,
    content,
    mode = 'overwrite',
    start = '0', 
    end = '-1'
  } = props;

  if (!path) {
    return {
      success: false,
      error: 'No path provided',
      tool: 'writeFile',
      params: props
    };
  }

  if (!content) {
    return {
      success: false,
      error: 'No content was provided',
      tool: 'writeFile',
      params: props
    };
  }

  try {
    const targetPath = path.trim();
    const fileExisted = existsSync(targetPath);
    let finalContent = content;
    let operationType = 'write';

    // Extract content from code blocks if present
    if (content.indexOf('```') !== -1) {
      let contentBlocks = '';
      let contentBlockCount = 0;
      let matched: RegExpMatchArray = content.match(CONTENT_BLOCK_REGEX);
      
      if (matched && matched.length > 0) {
        while (CONTENT_BLOCK_REGEX.exec(content)) {
          const match = CONTENT_BLOCK_REGEX.exec(content);
          if (match) {
            contentBlocks += match[2];
            contentBlockCount++;
            if (contentBlockCount > 0) contentBlocks += '\n';
          }
        }
        finalContent = contentBlocks;
      }
    }

    // Handle different write modes
    if (fileExisted && mode === 'create') {
      return {
        success: false,
        error: 'File already exists and overwrite is set to false',
        tool: 'writeFile',
        params: props
      };
    }

    if (fileExisted && mode === 'overwrite') {
      await fs.unlink(targetPath);
      operationType = 'overwrite';
    }

    if (fileExisted && mode === 'append') {
      const existingContent = (await fs.readFile(targetPath, 'utf-8')).toString();
      finalContent = `${existingContent}\n${finalContent.trim()}`;
      await fs.unlink(targetPath);
      operationType = 'append';
    }

    if (fileExisted && mode === 'prepend') {
      const existingContent = (await fs.readFile(targetPath, 'utf-8')).toString();
      finalContent = `${finalContent.trim()}\n${existingContent}`;
      await fs.unlink(targetPath);
      operationType = 'prepend';
    }

    if (fileExisted && mode === 'insert') {
      const lines = finalContent.split('\n');
      const existing = (await fs.readFile(targetPath, 'utf-8')).toString().split('\n');
      const startLine = parseInt(start);
      const endLine = parseInt(end);
      
      if (endLine < startLine) {
        return {
          success: false,
          error: 'Invalid start and end line parameters',
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

    // Write the file
    await fs.writeFile(targetPath, finalContent.trim(), 'utf-8');
    
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
    
    return {
      success: false,
      error: `Failed to write file: ${err.message}`,
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
  roles: ['DEVELOPER', 'ADMIN'],
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
            type: "string",
            description: "Start line number for insert mode"
          },
          end: {
            type: "string",
            description: "End line number for insert mode"
          }
        },
        required: ["path", "content"]
      }
    }
  }]
}
