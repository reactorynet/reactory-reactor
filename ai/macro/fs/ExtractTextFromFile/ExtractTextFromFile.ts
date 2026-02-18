import { promises as fs, existsSync } from 'fs';
import pathModule from 'path';
import { ExtractTextFromFileProps, ExtractTextFromFileResult } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

export const ExtractTextFromFile: Macro<ExtractTextFromFileResult, ExtractTextFromFileProps> = async (
  props: ExtractTextFromFileProps,
  state: ChatState): Promise<ExtractTextFromFileResult> => {
  const startTime = Date.now();
  const { path, start, end } = props;

  if (!path) {
    return {
      success: false,
      error: 'No path provided',
      tool: 'extractTextFromFile',
      params: props
    };
  }

  if (!start || !end) {
    return {
      success: false,
      error: 'Start and end line numbers are required',
      tool: 'extractTextFromFile',
      params: props
    };
  }

  if (isNaN(Number(start)) || isNaN(Number(end))) {
    return {
      success: false,
      error: 'Invalid parameters. Start and end must be valid numbers',
      tool: 'extractTextFromFile',
      params: props
    };
  }

  try {
    const targetPath = path.trim();
    const startLine = Number(start);
    const endLine = Number(end);

    // Check if file exists
    if (!existsSync(targetPath)) {
      return {
        success: false,
        error: `File does not exist: ${targetPath}`,
        tool: 'extractTextFromFile',
        params: props
      };
    }

    // Validate line range
    if (endLine < startLine) {
      return {
        success: false,
        error: 'Invalid line range. End line must be greater than or equal to start line',
        tool: 'extractTextFromFile',
        params: props
      };
    }

    if (startLine < 1) {
      return {
        success: false,
        error: 'Start line must be 1 or greater',
        tool: 'extractTextFromFile',
        params: props
      };
    }

    // Read file content
    const data = (await fs.readFile(targetPath, 'utf-8')).toString();
    const lines = data.split('\n');
    const totalLines = lines.length;

    // Validate line range against file size
    if (startLine > totalLines) {
      return {
        success: false,
        error: `Start line ${startLine} exceeds file length (${totalLines} lines)`,
        tool: 'extractTextFromFile',
        params: props
      };
    }

    // Adjust end line if it exceeds file length
    const adjustedEndLine = Math.min(endLine, totalLines);
    const portion = lines.slice(startLine - 1, adjustedEndLine).join('\n');
    
    // Get file stats for metadata
    const stats = await fs.stat(targetPath);
    const mimeType = pathModule.extname(targetPath).substring(1) || 'txt';
    const executionTime = Date.now() - startTime;

    // Create formatted output
    const formattedOutput = `\`\`\`${mimeType}\n${portion}\n\`\`\``;

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastExtractedText = {
      path: targetPath,
      extractedText: portion,
      lineRange: { start: startLine, end: adjustedEndLine, totalLines },
      mimeType,
      lastAccessed: new Date()
    };

    // Log access for security
    logger.info(`ExtractTextFromFile macro accessed: ${targetPath} (lines ${startLine}-${adjustedEndLine}) by user: ${state.user?.id || 'unknown'}`);

    return {
      success: true,
      data: {
        path: targetPath,
        extractedText: portion,
        lineRange: {
          start: startLine,
          end: adjustedEndLine,
          totalLines
        },
        fileInfo: {
          mimeType,
          size: stats.size,
          sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
          lastModified: stats.mtime
        },
        formattedOutput
      },
      tool: 'extractTextFromFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: targetPath,
        lineRange: `${startLine}-${adjustedEndLine}`
      },
      instructions: `
## Text Extraction Results

Successfully extracted text from: **${pathModule.basename(targetPath)}**

### Extraction Information:
- **Path**: ${targetPath}
- **Line Range**: ${startLine}-${adjustedEndLine} (${adjustedEndLine - startLine + 1} lines)
- **Total File Lines**: ${totalLines}
- **File Type**: ${mimeType}
- **File Size**: ${(stats.size / 1024).toFixed(2)}KB
- **Last Modified**: ${stats.mtime.toISOString()}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **extractedText**: Raw extracted text content
- **lineRange**: Line range information (start, end, total lines)
- **fileInfo**: File metadata (type, size, modification date)
- **formattedOutput**: Formatted code block for display

### State Variables Available:
- lastExtractedText: Complete extraction information for future reference

### Usage:
- Use the \`extractedText\` field for text processing or analysis
- Use \`lineRange\` for line number context
- Use \`fileInfo\` for file metadata
- Use \`formattedOutput\` for display in chat responses
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error extracting text from file at ${path}:`, err);
    
    return {
      success: false,
      error: `Error reading file at ${path}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'extractTextFromFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: path.trim(),
        lineRange: `${start}-${end}`
      }
    };
  }
};

export const ExtractFileComponentRegister: MacroComponentDefinition<typeof ExtractTextFromFile> = {
  component: ExtractTextFromFile,
  name: 'snip',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Extracts a portion of text from a file between specified line numbers with structured results and metadata',
  features: [],
  stem: 'snip',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'extract', 'portion', 'slice', 'snip'],
  tools: [{
    type: "function",
    function: {
      name: "snip",
      description: "Extracts a portion of text from a file between specified line numbers with comprehensive metadata",
      icon: "content_cut",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to extract text from"
          },
          start: {
            type: "number", 
            description: "Start line number (1-based)"
          },
          end: {
            type: "number",
            description: "End line number (1-based)"
          }
        },
        required: ["path", "start", "end"]
      }
    }
  }],
  alias: 'snip'
};
