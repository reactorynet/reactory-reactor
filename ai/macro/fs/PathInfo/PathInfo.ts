import { promises as fs, readFileSync, existsSync } from 'fs';
import pathModule from 'path';
import { PathInfoProps, PathInfoResult } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';
import { R_OK, W_OK } from 'constants';
import { PathInfo } from '@reactory/server-modules/reactory-reactor/types/macro.types';

export const getFileInfo = async (path: string): Promise<PathInfo> => {
  const pathInfo: PathInfo = {
    name: '',
    extension: '',
    size: 0,
    created: undefined,
    modified: undefined,
    accessed: undefined,
    isDirectory: false,
    isFile: false,
    isSymbolicLink: false,
    isWritable: false,
    isReadable: false,
    isExecutable: false,
    owner: '',
    group: '',
    path: '',
    absolutePath: '',
    relativePath: '',
    parentPath: '',
    parentAbsolutePath: '',
    parentRelativePath: '',
    error: undefined,
  };
  try {
    if (!path) throw new Error('Path is empty');
    if(existsSync(path) === false) throw new Error('Path does not exist');
    const stat = await fs.stat(path);
    const pathParsed = pathModule.parse(path);
    pathInfo.name = pathParsed.base;
    pathInfo.extension = pathParsed.ext;
    pathInfo.size = stat.size;
    pathInfo.created = stat.birthtime;
    pathInfo.modified = stat.mtime;
    pathInfo.accessed = stat.atime;
    pathInfo.isDirectory = stat.isDirectory();
    pathInfo.isFile = stat.isFile();
    pathInfo.isSymbolicLink = stat.isSymbolicLink();
    pathInfo.isBlockDevice = stat.isBlockDevice();
    pathInfo.isCharacterDevice = stat.isCharacterDevice();
    pathInfo.isFIFO = stat.isFIFO();
    pathInfo.isSocket = stat.isSocket();
    pathInfo.isExecutable = (stat.mode & 0o111) !== 0;
    pathInfo.owner = (await fs.lstat(path)).uid.toString();
    pathInfo.group = (await fs.lstat(path)).gid.toString();
    pathInfo.mode = (stat.mode & 0o777).toString(8);
    pathInfo.path = path;
    pathInfo.absolutePath = pathModule.resolve(path);
    pathInfo.relativePath = pathModule.relative('.', path);
    pathInfo.parentPath = pathModule.dirname(path);
    pathInfo.parentAbsolutePath = pathModule.resolve(pathModule.dirname(path));
    pathInfo.parentRelativePath = pathModule.relative('.', pathModule.dirname(path));
    try {
      await fs.access(path, R_OK);
      pathInfo.isReadable = true;
    } catch {
      pathInfo.isReadable = false;
    }
    try {
      await fs.access(path, W_OK);
      pathInfo.isWritable = true;
    } catch {
      pathInfo.isWritable = false;
    }
  } catch (err) {
    console.error(`Error getting file info for ${path}:`, err);
    pathInfo.error = err;
  }
  return pathInfo;
};

export const PathInfoMacro: Macro<PathInfoResult, PathInfoProps> = async (
  props: PathInfoProps,
  state: ChatState): Promise<PathInfoResult> => {
  const startTime = Date.now();
  const { path } = props;

  if (!path) {
    return {
      success: false,
      error: 'No path provided',
      tool: 'pathInfo',
      params: props
    };
  }

  try {
    const targetPath = path.trim();
    const fileInfo = await getFileInfo(targetPath);
    const executionTime = Date.now() - startTime;

    // Check if there was an error in getFileInfo
    if (fileInfo.error) {
      return {
        success: false,
        error: `Failed to get path info: ${fileInfo.error.message || 'Unknown error'}`,
        tool: 'pathInfo',
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          path: targetPath
        }
      };
    }

    // Create summary information
    const summary = {
      type: fileInfo.isDirectory ? 'Directory' : 
             fileInfo.isFile ? 'File' : 
             fileInfo.isSymbolicLink ? 'Symbolic Link' : 'Other',
      sizeFormatted: fileInfo.size ? `${(fileInfo.size / 1024).toFixed(2)}KB` : '0B',
      permissions: `${fileInfo.isReadable ? 'r' : '-'}${fileInfo.isWritable ? 'w' : '-'}${fileInfo.isExecutable ? 'x' : '-'}`,
      lastModified: fileInfo.modified ? fileInfo.modified.toISOString() : 'Unknown',
      isAccessible: fileInfo.isReadable || fileInfo.isWritable
    };

    const formattedOutput = `\`\`\`json\n${JSON.stringify(fileInfo, null, 2)}\n\`\`\``;

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastPathInfo = {
      path: targetPath,
      pathInfo: fileInfo,
      summary,
      lastAccessed: new Date()
    };

    // Log access for security
    logger.info(`PathInfo macro accessed: ${targetPath} by user: ${state.user?.id || 'unknown'}`);

    return {
      success: true,
      data: {
        pathInfo: fileInfo,
        summary,
        formattedOutput
      },
      tool: 'pathInfo',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: targetPath
      },
      instructions: `
## Path Information Results

Successfully retrieved information for: **${fileInfo.name}**

### Path Information:
- **Path**: ${targetPath}
- **Type**: ${summary.type}
- **Size**: ${summary.sizeFormatted}
- **Permissions**: ${summary.permissions}
- **Last Modified**: ${summary.lastModified}
- **Accessible**: ${summary.isAccessible ? 'Yes' : 'No'}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **pathInfo**: Complete PathInfo object with all file/directory details
- **summary**: Human-readable summary of key information
- **formattedOutput**: JSON formatted output for display

### State Variables Available:
- lastPathInfo: Complete path information for future reference

### Usage:
- Use the \`pathInfo\` object for detailed file/directory analysis
- Use \`summary\` for quick overview information
- Use \`formattedOutput\` for display in chat responses
- Use \`data\` for comprehensive path information
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error getting path info for ${path}:`, err);
    
    return {
      success: false,
      error: `Failed to get path info: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'pathInfo',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: path.trim()
      }
    };
  }
};

export const PathInfoComponentRegister: MacroComponentDefinition<typeof PathInfoMacro> = {
  component: PathInfoMacro,
  name: 'pathInfo',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Gets detailed information about a file or directory with structured results and metadata',
  features: [],
  stem: 'file',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'info', 'path', 'pathInfo'],
  tools: [{
    type: "function",
    function: {
      name: "pathInfo",
      description: "Gets detailed information about a file or directory with comprehensive metadata",
      icon: "info",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file or directory path to get info for"
          }
        },
        required: ["path"]
      }
    }
  }]
};
