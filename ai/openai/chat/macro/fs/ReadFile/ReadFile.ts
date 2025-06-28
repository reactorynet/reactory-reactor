import os from 'os';
import pathModule from 'path';
import { promises as fs, readFileSync, existsSync } from 'fs';
import logger from '@reactory/server-core/logging';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { ReadFileProps } from '../types';

export const ReadFile: Macro<string, ReadFileProps> = async (
  props: ReadFileProps,
  state: ChatState): Promise<string> => {
  const { path, id } = props;
  let targetPath = path?.trim();
  if (!targetPath) return 'No path provided';
  if (targetPath.startsWith("~")) targetPath = targetPath.replace("~", os.homedir());
  if (targetPath.startsWith(".")) targetPath = pathModule.resolve(targetPath);
  const WORKING_FOLDER = process.cwd();
  if (existsSync(pathModule.join(WORKING_FOLDER, targetPath))) {
    targetPath = pathModule.join(WORKING_FOLDER, targetPath);
  }
  const HOME_FOLDER = os.homedir();
  if (!targetPath.startsWith(HOME_FOLDER)) {
    return 'Operation not allowed. You can only read files in your home directory';
  }
  try {
    const data = await fs.readFile(targetPath.trim(), 'utf-8');
    const mime = targetPath.split('.').pop() || 'txt';
    const idAttribute = id ? ` id="${id}"` : '';
    return `\`\`\`${mime}${idAttribute}\n${data.toString()}\n\`\`\``;
  } catch (err) {
    logger.error(`Error reading file at ${targetPath}:`, err);
    return `\`\`\`\n ## ERROR - Macro ReadFile Failed\n${err.message}\n\`\`\``;
  }
};

export const ReadFileComponentRegister: MacroComponentDefinition<typeof ReadFile> = {
  component: ReadFile,
  name: 'readFile',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  roles: ['DEVELOPER', 'ADMIN'],
  stem: 'file',
  tags: ['macro', 'file', 'read'],
  tools: [{
    type: "function",
    function: {
      name: "readFile",
      description: "Reads a file and returns its content as a code block",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to read"
          },
          id: {
            type: "string",
            description: "Optional ID for the code block"
          }
        },
        required: ["path"]
      }
    }
  }]
};
