import { promises as fs, readFileSync, existsSync } from 'fs';
import { WriteFileProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

const CONTENT_BLOCK_REGEX = /(```?.+?)\n([\s\S]+?)\n```/g;
const SUCCESS_MESSAGE = (path: string) => `File was written successfully to ${path.trim()}`;
const FAILED_MESSAGE = (path: string, err: Error) => `Failed to write file to ${path.trim()}: ${err?.message}`;

export const WriteFile: Macro<string, WriteFileProps> = async (
  props: WriteFileProps,
  state: ChatState) => {
  const {
    path,
    content,
    mode = 'overwrite',
    start = '0', 
    end = '-1'
  } = props;
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
          ...existing.slice(0, startLine - 1),
          ...lines,
          ...existing.slice(endLine)
        ];
        data = modifiedLines.join('\n');
      }
      await fs.writeFile(path.trim(), data.trim(), 'utf-8');
      return SUCCESS_MESSAGE(path.trim());
    }
    if(!content) return FAILED_MESSAGE(path.trim(), new Error('No content was provided'));
    if(content.indexOf('```') === -1) {
      return write(content);
    }
    let match;
    let contentBlocks = '';
    let contentBlockCount = 0;
    let matched: RegExpMatchArray = content.match(CONTENT_BLOCK_REGEX);
    if(!matched || matched?.length === 0) {
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
      description: "Writes content to a file with different modes",
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
