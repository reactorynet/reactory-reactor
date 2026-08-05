import { promises as fs } from 'fs';
import pathModule from 'path';
import { ListDirectoryProps, ListDirectoryResult } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DirectoryListFormatter, DirectoryListFormatterService, PathInfo } from '@reactory/server-modules/reactory-reactor/types/macro.types';
import logger from '@reactory/server-core/logging';
import { summarizeItems, truncateOutput } from '../../summarize';

const FQN_REGEX = /^\w+\.\w+(?:@.*)?$/;

const DEFAULT_DIRECTORY_LIST_FORMATTER: DirectoryListFormatter = (infos: any[]) => {
  const lines = infos.map((info: any) => {
    // support both legacy full PathInfo and new shorthand {n,e,s,d,f,p,m}
    const name = info.n || info.name;
    const isDir = info.d !== undefined ? info.d : info.isDirectory;
    if (isDir) {
      return `${name} (dir)`;
    }
    const ext = (info.e || info.extension) ? `.${info.e || info.extension}` : '';
    const sizeVal = info.s !== undefined ? info.s : info.size;
    const size = sizeVal ? `${Math.round(sizeVal / 1024)}KB` : '';
    return `${name}${ext}${size ? ` (${size})` : ''}`;
  });
  return lines.join('\n') + '\n\nLegend: n=Name, e=Ext, s=Size(bytes), d=IsDir(bool), f=IsFile(bool), p=Path, m=Modified';
};

const DEFAULT_DIRECTORY_JSON_FORMATTER: DirectoryListFormatter = (infos: any[]) => {
  return JSON.stringify(infos.map((info: any) => ({
    n: info.n || info.name,
    e: info.e || info?.extension,
    s: info.s !== undefined ? info.s : info?.size,
    d: info.d !== undefined ? info.d : info?.isDirectory,
    f: info.f !== undefined ? info.f : info?.isFile,
    p: info.p || info?.relativePath || info?.absolutePath || info?.path,
    m: info.m || info?.modified
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

// Shorthand mapper: only key data needed to work with directories/files
// n=name, e=ext, s=size(bytes), d=isDir, f=isFile, p=path, m=modified(iso)
const toShorthand = (pi: PathInfo) => ({
  n: pi.name,
  e: pi.extension || undefined,
  s: typeof pi.size === 'number' ? pi.size : undefined,
  d: !!pi.isDirectory,
  f: !!pi.isFile,
  p: pi.relativePath || pi.path || pi.absolutePath || undefined,
  m: pi.modified ? new Date(pi.modified).toISOString() : undefined
});

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

    // Convert to concise shorthand objects for output (key data only)
    const shorthandItems = fileInfos.map(toShorthand);

    // Calculate summary statistics (keep numeric for utility, but keep lean)
    const summary = {
      t: fileInfos.length,
      f: fileInfos.filter(item => item.isFile).length,
      d: fileInfos.filter(item => item.isDirectory).length,
      s: fileInfos.reduce((sum, item) => sum + (item.size || 0), 0),
      sf: ''
    };
    summary.sf = `${(summary.s / 1024).toFixed(2)}KB`;

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

    // Formatters now receive shorthand items
    const formattedOutput = formatter(shorthandItems);
    const finalOutput = escape ? `\`\`\`${formatterMime}\n${truncateOutput(formattedOutput)}\n\`\`\`` : truncateOutput(formattedOutput);
    const executionTime = Date.now() - startTime;

    // Apply item-level truncation for very large directories (on shorthand)
    const summarized = summarizeItems(shorthandItems);

    // Store slim state for AI reference (shorthand only)
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastListDirectory = {
      p: targetPath,
      items: summarized.items,
      sum: summary,
      pat: pattern.trim(),
      fmt: format,
      sub: includeSubfolders,
      at: new Date(),
      tr: summarized.truncated,
      tc: summarized.totalCount,
    };

    // Log access for security
    logger.info(`ListDirectory macro accessed: ${targetPath} by user: ${state.user?.id || 'unknown'}, pattern: ${pattern}`);

    return {
      success: true,
      data: {
        p: targetPath,
        items: summarized.items,
        sum: summary,
        out: finalOutput,
        fmt: format,
        pat: pattern.trim(),
        sub: includeSubfolders,
        tr: summarized.truncated,
        tc: summarized.totalCount,
      },
      tool: 'listDirectory',
      params: props,
      metadata: {
        ms: executionTime,
        ts: new Date(),
        u: state.user?.id,
        pat: pattern.trim(),
        fmt: format,
        sub: includeSubfolders
      },
      instructions: `Directory listed: ${pathModule.basename(targetPath)} | items:${summary.t} f:${summary.f} d:${summary.d} size:${summary.sf} | use items (shorthand n,e,s,d,f,p,m), sum(t,f,d,s,sf)`
    };

  } catch (err) {
    const ms = Date.now() - startTime;
    logger.error(`Error listing directory at ${path}:`, err);
    
    return {
      success: false,
      error: `Error listing directory: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'listDirectory',
      params: props,
      metadata: { ms, ts: new Date(), u: state.user?.id, pat: pattern.trim(), fmt: format, sub: subfolders }
    };
  }
};

export const ListDirectoryComponentRegister: MacroComponentDefinition<typeof ListDirectory> = {
  component: ListDirectory,
  name: 'listDirectory',
  nameSpace: 'reactor-macros',
  alias: 'listDirectory',
  version: '1.0.0',
  description: 'Lists files and directories using concise shorthand (n,e,s,d,f,p,m) + slim summary',
  features: [],
  stem: 'file',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
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
