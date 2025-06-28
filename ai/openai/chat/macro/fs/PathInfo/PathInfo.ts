import { promises as fs, readFileSync, existsSync } from 'fs';
import pathModule from 'path';
import { PathInfoProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';
import { R_OK, W_OK } from 'constants';
import { PathInfo } from 'modules/reactory-reactor/types/macro.types';

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

export const PathInfoMacro: Macro<string, PathInfoProps> = async (
  props: PathInfoProps,
  state: ChatState) => {
  const { path } = props;
  try {
    const fileInfo = await getFileInfo(path.trim());
    return `\`\`\`json\n${JSON.stringify(fileInfo)}\`\`\``;
  } catch (err) {
    logger.error(`Error reading file at ${path}:`, err);
    return '';
  }
};

export const PathInfoComponentRegister: MacroComponentDefinition<typeof PathInfoMacro> = {
  component: PathInfoMacro,
  name: 'pathInfo',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'info', 'path', 'pathInfo'],
  tools: [{
    type: "function",
    function: {
      name: "pathInfo",
      description: "Gets detailed information about a file or directory",
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
