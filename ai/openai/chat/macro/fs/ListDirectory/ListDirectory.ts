import { promises as fs } from 'fs';
import pathModule from 'path';
import { ListDirectoryProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DirectoryListFormatter, DirectoryListFormatterService, PathInfo } from '@reactory/server-modules/reactory-reactor/types/macro.types';

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

export const ListDirectory: Macro<string, ListDirectoryProps> = async (
  props: ListDirectoryProps,
  state: ChatState) => {
  const {
    path, 
    subfolders = false, 
    pattern = "*", 
    format = 'text',
    escape = true
  } = props;
  const includeSubfolders = subfolders;
  try {
    const fileInfos = await getFilesInFolder(path.trim(), pattern.trim(), includeSubfolders);
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

    if(escape) {
      return `\`\`\`${formatterMime}\n${formatter(fileInfos)}\n\`\`\``;
    } else {
      return formatter(fileInfos);
    }
  } catch (err) {
    // logger is not imported here, so just return error string
    return `Error listing directory: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
};

export const ListDirectoryComponentRegister: MacroComponentDefinition<typeof ListDirectory> = {
  component: ListDirectory,
  name: 'listDirectory',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'file',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
  tools: [{
    type: "function",
    function: {
      name: "listDirectory",
      description: "Lists files and directories in a specified path",
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
