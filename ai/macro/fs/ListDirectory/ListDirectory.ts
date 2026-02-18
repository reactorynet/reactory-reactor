import { promises as fs } from 'fs';
import pathModule from 'path';
import { ListDirectoryProps, ListDirectoryResult } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DirectoryListFormatter, DirectoryListFormatterService, PathInfo } from '@reactory/server-modules/reactory-reactor/types/macro.types';
import logger from '@reactory/server-core/logging';
import { summarizeItems, truncateOutput } from '../../summarize';

const FQN_REGEX = /^\w+\.\w+(?:@.*)?$/;

const DEFAULT_DIRECTORY_LIST_FORMATTER: DirectoryListFormatter = (pathInfos: PathInfo[]) => {
  return pathInfos.map(pathInfo => {
    if (pathInfo.isFile) {
      const extension = pathInfo.extension ? `.${pathInfo.extension}` : '';
      return `${pathInfo.name}${extension} (${pathInfo.size} bytes)`;
    } else {
      return `${pathInfo.name}`;
    }
  }).join('\n');
};

const DEFAULT_DIRECTORY_JSON_FORMATTER: DirectoryListFormatter = (pathInfos: PathInfo[]) => {
  return JSON.stringify(pathInfos.map(pathInfo => ({
    name: pathInfo.name,
    extension: pathInfo?.extension,
    size: pathInfo?.size,
    path: pathInfo?.absolutePath
  })));
};

const getFilesInFolder = async (path: string, pattern: string, subFolders: boolean = false): Promise<PathInfo[]> => { 
  const files = await fs.readdir(path.trim(), { encoding: 'utf-8', withFileTypes: true });
  const filteredFiles = pattern.trim() === '*' ? files : files.filter((entry) => {
    if (entry?.name && entry.name !== '.' && entry.name !== '..') {
      const regexPattern = new RegExp(pattern.replace(/\*/g, '.*'));
      return regexPattern.test(entry.name);
    }
    return false;
  });
  let fileInfos: PathInfo[] = [];
  for (const file of filteredFiles) {
    const filePath = pathModule.join(path, file.name);
    // getFileInfo is imported from macro.ts for now, or should be moved to a shared util
    const fileInfo = await import('../macro').then(m => m.getFileInfo(filePath));
    if(fileInfo.isDirectory && subFolders === true) { 
      const subFiles = await getFilesInFolder(filePath, pattern);
      fileInfos = fileInfos.concat(subFiles);
    }
    fileInfos.push(fileInfo);
  }
  return fileInfos;
};

export const ListDirectory: Macro<ListDirectoryResult, ListDirectoryProps> = async (
  props: ListDirectoryProps,
  state: ChatState): Promise<ListDirectoryResult> => {
  const startTime = Date.now();
  const {
    path, 
    subfolders = false, 
    pattern = "*", 
    format = 'text',
    escape = true
  } = props;

  if (!path) {
    return {
      success: false,
      error: 'No path provided',
      tool: 'listDirectory',
      params: props
    };
  }

  try {
    const targetPath = path.trim();
    const includeSubfolders = subfolders;
    
    // Check if directory exists
    try {
      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${targetPath}`,
          tool: 'listDirectory',
          params: props
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `Directory does not exist: ${targetPath}`,
        tool: 'listDirectory',
        params: props
      };
    }

    const fileInfos = await getFilesInFolder(targetPath, pattern.trim(), includeSubfolders);
    
    // Calculate summary statistics
    const summary = {
      totalItems: fileInfos.length,
      files: fileInfos.filter(item => item.isFile).length,
      directories: fileInfos.filter(item => item.isDirectory).length,
      totalSize: fileInfos.reduce((sum, item) => sum + (item.size || 0), 0),
      totalSizeFormatted: ''
    };
    summary.totalSizeFormatted = `${(summary.totalSize / 1024).toFixed(2)}KB`;

    let formatter: DirectoryListFormatter = DEFAULT_DIRECTORY_LIST_FORMATTER;
    let formatterMime: string = 'text';
    
    if(format === 'json') {
      formatter = DEFAULT_DIRECTORY_JSON_FORMATTER;
      formatterMime = 'text/json';
    }
    
    if(format != 'text' && FQN_REGEX.test(format)) {
      // For FQN, import macro.ts for getService
      const [ name, nameSpace, version = '1.0.0' ] = format.match(/^([\w]+)\.([\w]+)(?:@(.*))?$/) || [];
      const formatterService: DirectoryListFormatterService = state.context.getService<DirectoryListFormatterService>(`${nameSpace}.${name}@${version}`);
      if (formatterService) {
        formatter = formatterService.formatter;
        formatterMime = `text/vnd+${formatterService.nameSpace}.${formatterService.name}@${formatterService.version}`;
      }
    }

    const formattedOutput = formatter(fileInfos);
    const finalOutput = escape ? `\`\`\`${formatterMime}\n${truncateOutput(formattedOutput)}\n\`\`\`` : truncateOutput(formattedOutput);
    const executionTime = Date.now() - startTime;

    // Apply item-level truncation for very large directories
    const summarized = summarizeItems(fileInfos);

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastListDirectory = {
      path: targetPath,
      items: summarized.items,
      summary,
      pattern: pattern.trim(),
      format,
      includeSubfolders,
      lastAccessed: new Date(),
      truncated: summarized.truncated,
      totalCount: summarized.totalCount,
    };

    // Log access for security
    logger.info(`ListDirectory macro accessed: ${targetPath} by user: ${state.user?.id || 'unknown'}, pattern: ${pattern}`);

    return {
      success: true,
      data: {
        path: targetPath,
        items: summarized.items,
        summary,
        formattedOutput: finalOutput,
        format,
        pattern: pattern.trim(),
        includeSubfolders,
        truncated: summarized.truncated,
        totalCount: summarized.totalCount,
      },
      tool: 'listDirectory',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        pattern: pattern.trim(),
        format,
        includeSubfolders
      },
      instructions: `
## Directory Listing Results

Successfully listed directory: **${pathModule.basename(targetPath)}**

### Directory Information:
- **Path**: ${targetPath}
- **Total Items**: ${summary.totalItems}
- **Files**: ${summary.files}
- **Directories**: ${summary.directories}
- **Total Size**: ${summary.totalSizeFormatted}
- **Pattern**: ${pattern.trim()}
- **Include Subfolders**: ${includeSubfolders}
- **Format**: ${format}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **items**: Array of PathInfo objects with detailed file/directory information
- **summary**: Statistical summary of the directory contents
- **formattedOutput**: Formatted output string (with or without code blocks)
- **path**: Full directory path
- **pattern**: File pattern filter used
- **format**: Output format used

### State Variables Available:
- lastListDirectory: Complete directory information for future reference

### Usage:
- Use the \`items\` array for detailed file/directory analysis
- Use \`summary\` for statistical information
- Use \`formattedOutput\` for display in chat responses
- Use \`data\` for comprehensive directory information
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error listing directory at ${path}:`, err);
    
    return {
      success: false,
      error: `Error listing directory: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'listDirectory',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        pattern: pattern.trim(),
        format,
        includeSubfolders: subfolders
      }
    };
  }
};

export const ListDirectoryComponentRegister: MacroComponentDefinition<typeof ListDirectory> = {
  component: ListDirectory,
  name: 'listDirectory',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: 'Lists files and directories in a specified path with detailed metadata and structured results',
  features: [],
  stem: 'file',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
  tools: [{
    type: "function",
    function: {
      name: "listDirectory",
      description: "Lists files and directories in a specified path with comprehensive metadata",
      icon: "folder_open",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The directory path to list"
          },
          subfolders: {
            type: "boolean",
            description: "Whether to include subfolders in the list"
          },
          pattern: {
            type: "string",
            description: "File pattern filter (supports wildcards, default is '*')"
          },
          format: {
            type: "string",
            enum: ["text", "json"],
            description: "Output format: 'text', 'json', or a formatter FQN"
          },
          escape: {
            type: "boolean",
            description: "Whether to escape output in code blocks (default is true)"
          }
        },
        required: ["path"]
      }
    }
  }]
};
