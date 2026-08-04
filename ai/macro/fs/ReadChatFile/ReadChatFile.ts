import pathModule from 'path';
import { promises as fs, existsSync, readFileSync } from 'fs';
import logger from '@reactory/server-core/logging';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { MacroErrorCode } from '../../errors';

export interface ReadChatFileProps {
  fileId: string;
}

export interface ReadChatFileResult {
  success: boolean;
  error?: string;
  errorCode?: MacroErrorCode;
  data?: {
    content: string;
    codeBlock: string;
    metadata: {
      fileId: string;
      filename: string;
      path: string;
      size: number;
      sizeFormatted: string;
      mimeType: string;
    };
  };
  tool: string;
  params: ReadChatFileProps;
  instructions?: string;
}

const TEXT_MIMETYPES = [
  'text/', 'application/json', 'application/xml', 'application/javascript',
  'application/typescript', 'application/x-yaml', 'application/x-toml',
  'application/sql', 'application/graphql', 'application/xhtml+xml',
  'application/ld+json', 'application/x-httpd-php', 'application/x-sh',
  'application/csv', 'application/rtf',
];

const MAX_TEXT_SIZE = 512 * 1024; // 512KB

function isTextMimetype(mimetype: string): boolean {
  if (!mimetype) return false;
  const lower = mimetype.toLowerCase();
  return TEXT_MIMETYPES.some(prefix => lower.startsWith(prefix));
}

export const ReadChatFile: Macro<ReadChatFileResult, ReadChatFileProps> = async (
  props: ReadChatFileProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<ReadChatFileResult> => {
  const { fileId } = props;

  if (!fileId) {
    return {
      success: false,
      error: 'No fileId provided',
      errorCode: MacroErrorCode.VALIDATION_REQUIRED_PARAM,
      tool: 'readChatFile',
      params: props,
    };
  }

  const attachedFiles = state.files || [];
  const fileRecord = attachedFiles.find((f: any) => {
    const id = (f._id || f.id || '').toString();
    return id === fileId;
  });

  if (!fileRecord) {
    return {
      success: false,
      error: `File with id "${fileId}" is not attached to the current chat session. Available file ids: ${attachedFiles.map((f: any) => (f._id || f.id || '').toString()).join(', ') || 'none'}`,
      errorCode: MacroErrorCode.IO_NOT_FOUND,
      tool: 'readChatFile',
      params: props,
    };
  }

  const filePath = (fileRecord as any).path;
  const filename = (fileRecord as any).filename || 'unknown';
  const mimetype = (fileRecord as any).mimetype || 'application/octet-stream';
  const fileSize = (fileRecord as any).size || 0;
  const fileIdStr = ((fileRecord as any)._id || (fileRecord as any).id || fileId).toString();

  if (!filePath) {
    return {
      success: false,
      error: `File "${filename}" has no stored path. Cannot read content.`,
      tool: 'readChatFile',
      params: props,
    };
  }

  if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    try {
      if (!existsSync(filePath)) {
        return {
          success: false,
          error: `File not found on disk: ${filePath}`,
          errorCode: MacroErrorCode.IO_NOT_FOUND,
          tool: 'readChatFile',
          params: props,
        };
      }
      let pdfService: any = context?.getService ? context.getService('pdf-manager.PdfService@1.0.0') : null;
      if (!pdfService) {
        try {
          const PdfServiceClass = require('@reactory/server-modules/reactory-pdf-manager/services/PdfService').default;
          pdfService = new PdfServiceClass({}, context);
        } catch (e) {
          // fallback
        }
      }
      if (pdfService && typeof pdfService.toMarkdown === 'function') {
        const markdown = await pdfService.toMarkdown(filePath);
        const codeBlock = `\`\`\`markdown\n${markdown}\n\`\`\``;
        return {
          success: true,
          data: {
            content: markdown,
            codeBlock,
            metadata: {
              fileId: fileIdStr,
              filename,
              path: filePath,
              size: fileSize,
              sizeFormatted: `${(fileSize / 1024).toFixed(2)}KB`,
              mimeType: mimetype,
            },
          },
          tool: 'readChatFile',
          params: props,
        };
      }
    } catch (pdfErr: any) {
      logger.error(`Error extracting PDF text in ReadChatFile: ${pdfErr.message}`, { error: pdfErr });
      return {
        success: false,
        error: `Failed to extract PDF text: ${pdfErr.message}`,
        tool: 'readChatFile',
        params: props,
      };
    }
  }

  if (!isTextMimetype(mimetype)) {
    return {
      success: true,
      data: {
        content: `[Binary file — content cannot be displayed as text]`,
        codeBlock: '',
        metadata: {
          fileId: fileIdStr,
          filename,
          path: filePath,
          size: fileSize,
          sizeFormatted: `${(fileSize / 1024).toFixed(2)}KB`,
          mimeType: mimetype,
        },
      },
      tool: 'readChatFile',
      params: props,
      instructions: `This is a binary file (${mimetype}) and its content cannot be displayed as text. Inform the user of the file type and metadata.`,
    };
  }

  try {
    if (!existsSync(filePath)) {
      return {
        success: false,
        error: `File not found on disk: ${filePath}`,
        errorCode: MacroErrorCode.IO_NOT_FOUND,
        tool: 'readChatFile',
        params: props,
      };
    }

    const stats = await fs.stat(filePath);

    if (stats.size > MAX_TEXT_SIZE) {
      const truncatedContent = (await fs.readFile(filePath, 'utf-8')).substring(0, MAX_TEXT_SIZE);
      const ext = pathModule.extname(filename).replace('.', '') || 'txt';
      return {
        success: true,
        data: {
          content: truncatedContent,
          codeBlock: `\`\`\`${ext}\n${truncatedContent}\n\`\`\`\n\n*[File truncated — showing first ${(MAX_TEXT_SIZE / 1024).toFixed(0)}KB of ${(stats.size / 1024).toFixed(2)}KB]*`,
          metadata: {
            fileId: fileIdStr,
            filename,
            path: filePath,
            size: stats.size,
            sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
            mimeType: mimetype,
          },
        },
        tool: 'readChatFile',
        params: props,
        instructions: `File was truncated because it exceeds the ${(MAX_TEXT_SIZE / 1024).toFixed(0)}KB limit. Only the first portion is shown.`,
      };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const ext = pathModule.extname(filename).replace('.', '') || 'txt';
    const codeBlock = `\`\`\`${ext}\n${content}\n\`\`\``;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastReadChatFile = {
      fileId: fileIdStr,
      filename,
      path: filePath,
      content,
      size: stats.size,
      mimeType: mimetype,
    };

    logger.info(`ReadChatFile macro accessed: ${filePath} (fileId: ${fileIdStr}) by user: ${state.user?.id || 'unknown'}`);

    return {
      success: true,
      data: {
        content,
        codeBlock,
        metadata: {
          fileId: fileIdStr,
          filename,
          path: filePath,
          size: stats.size,
          sizeFormatted: `${(stats.size / 1024).toFixed(2)}KB`,
          mimeType: mimetype,
        },
      },
      tool: 'readChatFile',
      params: props,
      instructions: `
## Chat File Read Results

Successfully read attached file: **${filename}**

### File Information:
- **File ID**: ${fileIdStr}
- **Filename**: ${filename}
- **Path**: ${filePath}
- **Size**: ${(stats.size / 1024).toFixed(2)}KB
- **Type**: ${mimetype}

### Available Data:
- **content**: Raw file content as string
- **codeBlock**: Formatted markdown code block with syntax highlighting
- **metadata**: File statistics and properties
      `,
    };
  } catch (err) {
    logger.error(`Error reading chat file ${filePath} (fileId: ${fileIdStr}):`, err);
    return {
      success: false,
      error: `Failed to read file: ${err.message}`,
      tool: 'readChatFile',
      params: props,
    };
  }
};

export const ReadChatFileComponentRegister: MacroComponentDefinition<typeof ReadChatFile> = {
  component: ReadChatFile,
  name: 'readChatFile',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  roles: [],
  stem: 'file',
  tags: ['macro', 'file', 'read', 'chat'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "readChatFile",
      description: "Reads the contents of a file attached to the current chat session. Use the file id from the attached files list provided in the system context.",
      icon: "attach_file",
      parameters: {
        type: "object",
        properties: {
          fileId: {
            type: "string",
            description: "The ID of the attached file to read",
          },
        },
        required: ["fileId"],
      },
    },
  }],
};
