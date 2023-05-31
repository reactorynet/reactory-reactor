import { promises as fs, readFileSync } from 'fs';
import { ChatState, Macro } from '@reactory/server-modules/reactor/types/chat.types';
import logger from '@reactory/server-core/logging';



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
  description: readFileSync(require.resolve('./docs/ReadFile.md'), 'utf-8').toString(),
  domain: 'file',
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'read'],
}

const CODE_BLOCK_REGEX = /```(.+?)\n([\s\S]+?)\n```/g;

export const WriteFile: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [path, content] = args;
  try {
    // Extract code blocks from content using regex    
    let match;
    let codeBlocks = '';    
    let codeBlockCount = 0;
    while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {      
      switch(match.length) {
        case 3: {
          codeBlocks += match[2];
          break;
        }
        case 2: { 
          codeBlocks += match[1];
          break;
        }
        case 1: {
          codeBlocks += match[0];
          break;
        }
      }
      codeBlockCount++;
      if (codeBlockCount > 0) codeBlocks += '\n';
    }
    await fs.writeFile(path.trim(), codeBlocks.trim(), 'utf-8');
    return `File was written successfully at ${path.trim()}`;
  } catch (err) {
    logger.error(`Error writing to file at ${path}:`, err);
    return `Failed to write file at ${path}: ${err?.message}`;
  }
}

export const WriteFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof WriteFile> = {
  component: WriteFile,
  name: 'WriteFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./docs/WriteFile.md'), 'utf-8').toString(),
  domain: 'file',
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'write', 'save', 'output'],
}

/*
 * A macro that extracts the content of a directory and returns it as a list
 * when subfolders are set to true, it will also include subfolders
 */

// 
// Usage: @ls(path, subfolders, format)
export const ListDirectory: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [path, subfolders, pattern = "*", format = 'text'] = args;
  const includeSubfolders = subfolders === 'true' || subfolders === '1';
  try {
    // Read the directory
    const files = await fs.readdir(path.trim());

    // Filter out the directories
    const filteredFiles = includeSubfolders ? files : files.filter(file => !file.includes('.'));

    // Convert to a list
    const list = filteredFiles.map(file => `- ${file}`).join('\n');

    return list;
  } catch (err) {
    console.error(`Error reading directory at ${path}:`, err);
    return '';
  }
}

export const ListDirectoryComponentRegister: Reactory.IReactoryComponentDefinition<typeof ListDirectory> = {
  component: ListDirectory,
  name: 'ListDirectory',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./docs/ListDirectory.md'), 'utf-8').toString(),
  domain: 'file',
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'list', 'ls', 'dir'],
}


// A macro that extracts a portion of a file and returns it as a text block
// Usage: @extract(path, start, end)
export const ExtractFile: Macro<string> = async (
  args: string[],
  state: ChatState
) => {
  // Check for valid input parameters
  if (args.length !== 3 || isNaN(+args[1]) || isNaN(+args[2])) {
    return `Invalid parameters. Usage: @extract(path, start, end)`;
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

    // Extract the portion
    const portion = lines.slice(startLine - 1, endLine).join('\n');

    // Return it as a text block
    return `\`\`\\${mime}
    ${portion}
    \`\`\``;
  } catch (err) {
    console.error(`Error reading file at ${path}:`, err);
    return `Error reading file at ${path}: ${err?.message}`;
  }
};

export const ExtractFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof ExtractFile> = {
  component: ExtractFile,
  name: 'ExtractFile',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./docs/ExtractFile.md'), 'utf-8').toString(),
  domain: 'file',
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'extract', 'portion', 'slice'],
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
    console.error(`Error writing file at ${path}:`, err);
    return `Error writing file at ${path}: ${err?.message}`;
  }
};

export const InsertSnippetComponentRegister: Reactory.IReactoryComponentDefinition<typeof InsertSnippet> = {
  component: InsertSnippet,
  name: 'InsertSnippet',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: readFileSync(require.resolve('./docs/InsertSnippet.md'), 'utf-8').toString(),
  domain: 'file',
  features: [],
  stem: 'file',
  tags: ['macro', 'file', 'insert', 'snippet', 'replace'],
}


export const FileMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  ReadFileComponentRegister,
  WriteFileComponentRegister,
  ListDirectoryComponentRegister,
  ExtractFileComponentRegister,
  InsertSnippetComponentRegister,
];
