import pathModule from 'path';
import os from 'os';
import { promises as fs, readFileSync, existsSync } from 'fs';
import fsExtra from 'fs-extra';
import { ChatState, Macro } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { PathInfo, DirectoryListFormatter, DirectoryListFormatterService} from '@reactory/server-modules/reactory-reactor/types/macro.types'
import logger from '@reactory/server-core/logging';
import { R_OK, W_OK } from 'constants';

/**
 * A Regex that matches a fully qualified name or fqn
 * i.e. core.System@1.0.0 or core.System will match
 */
const FQN_REGEX = /^(\w+)\.(\w+)(?:@(.*))?$/

/**
 * A macro that reads a file and returns its content as a code block
 * @param args - string[] - [ path, id ] - id is optional
 * @param state - ChatState
 * @returns 
 */
export const ReadFile: Macro<string> = async (
  args: any[],
  state: ChatState): Promise<string> => {
  const [path, id] = args;
  try {
    const data = await fs.readFile(path.trim(), 'utf-8');
    const mime = path.split('.').pop() || 'txt';
    return `\`\`\`${mime}${id ? ` id="${id}"` : ''}\n${data.toString()}\n\`\`\``;
  } catch (err) {
    logger.error(`Error reading file at ${path}:`, err);
    return `\`\`\`\n ## ERROR - Macro ReadFile Failed\'n${err.message}\n\`\`\``;;
  }
};

export const ReadFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof ReadFile> = {
  component: ReadFile,
  name: 'ReadFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'read'],
}

const CONTENT_BLOCK_REGEX = /(```?.+?)\n([\s\S]+?)\n```/g;
const SUCCESS_MESSAGE = (path: string) => `File was written successfully to ${path.trim()}`;
const FAILED_MESSAGE = (path: string, err: Error) => `Failed to write file to ${path.trim()}: ${err?.message}`;

export const WriteFile: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [
    path,
    content,
    mode = 'overwrite',
    start = '0', 
    end = '-1'
  ] = args;
  try {
    // Write the file
    const write = async (data: string) => {
      const exists = existsSync(path.trim());
      if(exists === true && mode === 'create') return FAILED_MESSAGE(path.trim(), new Error('File already exists and overwrite is set to false'));
      if(exists === true && mode === 'overwrite') await fs.unlink(path.trim());
      if(exists === true && mode === 'append') {
        data = `${(await fs.readFile(path.trim(), 'utf-8')).toString()}\n${data.trim()}`;
        await fs.unlink(path.trim());
      }
      if(exists === true && mode === 'prepend') {
        data = `${data.trim()}\n${(await fs.readFile(path.trim(), 'utf-8')).toString()}`;
        await fs.unlink(path.trim()); 
      }
      if(exists === true && mode === 'insert') {
        const lines = data.split('\n');
        const existing = (await fs.readFile(path.trim(), 'utf-8')).toString().split('\n');
        const startLine = parseInt(start);
        const endLine = parseInt(end);

        if(endLine < startLine) return FAILED_MESSAGE(path.trim(), new Error('Invalid start and end line parameters'));

        const modifiedLines = [
          ...existing.slice(0, startLine - 1), // Lines before the start line
          ...lines, // Snippet to insert or replace with
          ...existing.slice(endLine) // Lines after the end line (if any)
        ];

        data = modifiedLines.join('\n');
      }
      
      await fs.writeFile(path.trim(), data.trim(), 'utf-8');
      return SUCCESS_MESSAGE(path.trim());
    }

    if(!content) return FAILED_MESSAGE(path.trim(), new Error('No content was provided'));

    if(content.indexOf('```') === -1) {
      //write the entire content to the file
      return write(content);
    }

    let match;
    let contentBlocks = '';
    let contentBlockCount = 0;
    //extract the code blocks from the content
    //we do this because we want to write the content blocks as is
    let matched: RegExpMatchArray = content.match(CONTENT_BLOCK_REGEX);
    if(!matched || matched?.length === 0) {
      //write the entire content to the file and return
      return write(content);
    }

    while(match = CONTENT_BLOCK_REGEX.exec(content)) { 
      contentBlocks += match[2];
      contentBlockCount++;
      if(contentBlockCount > 0) contentBlocks += '\n';
    }

    return write(contentBlocks);
  } catch (err) {
    return FAILED_MESSAGE(path.trim(), err);
  }
}

export const WriteFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof WriteFile> = {
  component: WriteFile,
  name: 'WriteFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'write', 'save', 'output'],
}

/**
 * Gets the file info for the given path and returns it as a PathInfo object
 * @param path - string - the path to get the file info for
 * @returns - PathInfo - the file info for the given path
 */
const getFileInfo = async (path: string): Promise<PathInfo> => {
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
  }

  try {
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
    } catch (err) {
      pathInfo.isReadable = false;
    }

    try {
      await fs.access(path, W_OK);
      pathInfo.isWritable = true;
    } catch (err) {
      pathInfo.isWritable = false;
    }
  }
  catch (err) {
    console.error(`Error getting file info for ${path}:`, err);
  } finally {
    return pathInfo;
  }
}

/**
 * Default TEXT formatter for directory lists, will only return the following information:
 * - name
 * - extension - if a file
 * - size (in bytes) - if a file
 * @param pathInfos 
 */
const DEFAULT_DIRECTORY_LIST_FORMATTER: DirectoryListFormatter = (pathInfos: PathInfo[]) => {
  return pathInfos.map(pathInfo => {
    if (pathInfo.isFile) {
      return `${pathInfo.name}${pathInfo.extension ? `.${pathInfo.extension}` : ''} (${pathInfo.size} bytes)`;
    } else {
      return `${pathInfo.name}`;
    }
  }).join('\n');
}

/**
 * Default JSON formatter for directory lists, will only return the following information:
 * - name
 * - extension - if a file
 * - size (in bytes) - if a file
 * 
 * @param pathInfos 
 * @returns 
 */
const DEFAULT_DIRECTORY_JSON_FORMATTER: DirectoryListFormatter = (pathInfos: PathInfo[]) => {
  return JSON.stringify(pathInfos.map(pathInfo => {
    return {
      name: pathInfo.name,
      extension: pathInfo?.extension,
      size: pathInfo?.size,
      path: pathInfo?.absolutePath
    }
  }));
}

const getFilesInFolder = async (path: string, pattern: string, subFolders: boolean = false): Promise<PathInfo[]> => { 
  const files = await fs.readdir(path.trim(), { encoding: 'utf-8', withFileTypes: true });
  //filter out files that match the pattern
  const filteredFiles = pattern.trim() === '*' ? files : files.filter((entry) => {
    if (entry?.name && entry.name !== '.' && entry.name !== '..') {
      if (entry.name.match(pattern)) {
        return true;
      }
    }
    return false;
  });

  let fileInfos: PathInfo[] = [];
  for (const file of filteredFiles) {
    const filePath = pathModule.join(path, file.name);
    const fileInfo = await getFileInfo(filePath);
    if(fileInfo.isDirectory && subFolders === true) { 
      const subFiles = await getFilesInFolder(filePath, pattern);
      fileInfos = fileInfos.concat(subFiles);
    }
    fileInfos.push(fileInfo);
  }

  return fileInfos;
}

/*
 * A macro that extracts the content of a directory and returns it as a list
 * when subfolders are set to true, it will also include subfolders
 * 
 * Usage: @ls(path, subfolders, filter, format)
 * 
 * path - required parameter, the path to the directory to list
 * subfolders - optional parameter, whether to include subfolders in the list default is false
 * filter - optional parameter, a filter to apply to the list of files - accepts wildcards default is *
 * format - optional parameter, the format of the list - accepts text or json default is text, you 
 *  can specify a component fqn to use as the formatter as well. i.e. @ls(path, subfolders, filter, macro.DirectoryListFormatter?@version)
 * 
 * returns a list of files in the directory either as plain text or a json.
 */
export const ListDirectory: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [
    path, 
    subfolders = 'false', 
    pattern = "*", 
    format = 'text',
    escape = 'true'
  ] = args;
  const includeSubfolders = subfolders === 'true' || subfolders === '1';
  try {
    // Read the directory
    const fileInfos = await getFilesInFolder(path.trim(), pattern.trim(), includeSubfolders);

    let formatter: DirectoryListFormatter = DEFAULT_DIRECTORY_LIST_FORMATTER;
    let formatterMime: string = 'text';
    if(format === 'json') {
      formatter = DEFAULT_DIRECTORY_JSON_FORMATTER;
      formatterMime = 'text/json';
    }

    if(FQN_REGEX.test(format)) {
      const [ name, nameSpace, version = '1.0.0' ] = format.match(FQN_REGEX);
      const formatterService: DirectoryListFormatterService = state.context.getService<DirectoryListFormatterService>(`${nameSpace}.${name}@${version}`);
      if (formatterService) {
        formatter = formatterService.formatter
        formatterMime = `text/vnd+${formatterService.nameSpace}.${formatterService.name}@${formatterService.version}`;
      } else {
        return `Formatter service ${nameSpace}.${name}@${version} not found`;
      }
    }

    if(escape === 'true') {
      return `\`\`\`${formatterMime}\n${formatter(fileInfos)}\n\`\`\``;
    } else {
      return formatter(fileInfos);
    }
  } catch (err) {
    logger.error(`Error reading directory at ${path}:`, err);
    return '';
  }
}

/**
 * Macro for extracting detailed information about a file or directory
 * @param args 
 * @param state 
 * @returns 
 */
export const PathInfoMacro: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [path] = args;
  try {
    const fileInfo = await getFileInfo(path.trim());
    return `\`\`\`json\n${JSON.stringify(fileInfo)}\`\`\``;
  } catch (err) {
    logger.error(`Error reading file at ${path}:`, err);
    return '';
  }
}

/**
 * Macro for extracting detailed information about a file or directory
 */
export const PathInfoComponentRegister: Reactory.IReactoryComponentDefinition<typeof PathInfoMacro> = {
  component: PathInfoMacro,
  name: 'PathInfo',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'info', 'path', 'pathInfo'],
}

/**
 * Macro registry entry for the ListDirectory macro
 */
export const ListDirectoryComponentRegister: Reactory.IReactoryComponentDefinition<typeof ListDirectory> = {
  component: ListDirectory,
  name: 'ListDirectory',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
}

/**
 * A macro that deletes a folder and all subfolders and files
 */
export const RemoveDirectory: Macro<string> = async (
  args: string[],
  state: ChatState
) => {
  const [path] = args;
  try {
    await fsExtra.rmdir(path.trim(), { recursive: true });
    return `Folder ${path} deleted successfully`;
  } catch(err) {
    return `Error deleting folder ${path}: ${err?.message}`;
  }
}

export const RemoveDirectoryComponentRegister: Reactory.IReactoryComponentDefinition<typeof RemoveDirectory> = {
  component: RemoveDirectory,
  name: 'ListDirectory',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: `A simple macro that deletes a folder and all subfolders and files`,
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
}

/**
 * 
 * @param args 
 * @param state 
 * @returns 
 */
export const ExtractTextFromFile: Macro<string> = async (
  args: string[],
  state: ChatState
) => {
  // Check for valid input parameters
  if (args.length !== 3 || isNaN(+args[1]) || isNaN(+args[2])) {
    return `Invalid parameters. Usage: @snipText(path, start, end)`;
  }

  const [path, start, end] = args;
  try {
    // Read the file
    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    const mime = path.split('.').pop() || 'txt';
    // Split the data into lines
    const lines = data.split('\n');
    const startLine = parseInt(start);
    const endLine = parseInt(end);

    if(endLine < startLine) return `Invalid parameters. Usage: @snipText(path, start, end) end must be larger than the start`;

    // Extract the portion
    const portion = lines.slice(startLine - 1, endLine).join('\n');
    const content = `${mime}\n${portion}`
    // Return it as a text block
    return `\`\`\`${content}\n\`\`\``;
  } catch (err) {
    console.error(`Error reading file at ${path}:`, err);
    return `Error reading file at ${path}: ${err?.message}`;
  }
};

/**
 * Macro registry entry for the ExtractFile macro
 */
export const ExtractFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof ExtractTextFromFile> = {
  component: ExtractTextFromFile,
  name: 'snipText',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./snipText.md'), 'utf-8').toString(),
  features: [],
  stem: 'snip',
  tags: ['macro', 'file', 'extract', 'portion', 'slice', 'snip'],
}

// A macro that inserts a snippet into a file starting from a specified line
// Usage: @insertSnippet(path, start, [end], snippet)
export const InsertSnippet: Macro<string> = async (
  args: string[],
  state: ChatState
) => {
  const [path, start, end, snippet] = args;
  try {
    // Read the file
    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    // Split the data into lines
    const lines = data.split('\n');
    const startLine = parseInt(start);
    const endLine = end ? parseInt(end) : startLine;

    // Insert or replace the snippet
    const modifiedLines = [
      ...lines.slice(0, startLine - 1), // Lines before the start line
      snippet, // Snippet to insert or replace with
      ...lines.slice(endLine) // Lines after the end line (if any)
    ];

    // Join the modified lines back together
    const modifiedData = modifiedLines.join('\n');

    // Write the modified data back to the file
    await fs.writeFile(path.trim(), modifiedData, 'utf-8');

    return `Snippet inserted into ${path} successfully.`;
  } catch (err) {
    logger.error(`Error writing file at ${path}:`, err);
    return `Error writing file at ${path}`;
  }
};

export const MakeDirectory: Macro<string> = async (
  paths: string[],
  state: ChatState
) => {    
  let response = '';
  for(const path of paths) {

    try {
      await fs.mkdir(path.trim(), { recursive: true });
      response += `✅ ${path}\n`;
    } catch (err) {
      response += `❗ ${path}\n`;
    }
  }
  return response;  
}

export const MakeDirectoryComponentRegister: Reactory.IReactoryComponentDefinition<typeof MakeDirectory> = { 
  component: MakeDirectory,
  name: 'mkdir',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./mkdir.md'), 'utf-8').toString(),
  features: [],
  stem: 'mkdir',
  tags: ['macro', 'file', 'create', 'make', 'dir', 'folder'],
}

export const DeleteDirectory: Macro<string> = async (
  paths: string[],
  state: ChatState
) => {    
  let response = '';
  for(const path of paths) {

    try {
      await fs.rmdir(path.trim());
      response += `✅ ${path}\n`;
    } catch (err) {
      response += `❗ ${path}\n`;
    }
  }
  return response;  
}

export const DeleteDirectoryComponentRegister: Reactory.IReactoryComponentDefinition<typeof DeleteDirectory> = { 
  component: DeleteDirectory,
  name: 'rmdir',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./rmdir.md'), 'utf-8').toString(),
  features: [],
  stem: 'rmdir',
  tags: ['macro', 'file', 'delete', 'remove', 'dir', 'folder'],
}

export const InsertSnippetComponentRegister: Reactory.IReactoryComponentDefinition<typeof InsertSnippet> = {
  component: InsertSnippet,
  name: 'insertText',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./insertText.md'), 'utf-8').toString(),
  features: [],
  stem: 'insertText',
  tags: ['macro', 'file', 'insert', 'snippet', 'replace', 'insert'],
}


export const FileMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  ReadFileComponentRegister,
  WriteFileComponentRegister,
  ListDirectoryComponentRegister,
  ExtractFileComponentRegister,
  InsertSnippetComponentRegister,
  PathInfoComponentRegister,
];
