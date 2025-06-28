import { promises as fs } from 'fs';
import { MakeDirectoryProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

export const MakeDirectory: Macro<string, MakeDirectoryProps> = async (
  props: MakeDirectoryProps,
  state: ChatState
) => {    
  let response = '';
  const { paths } = props;
  for(const path of paths) {
    try {
      await fs.mkdir(path.trim(), { recursive: true });
      response += `✅ ${path}\n`;
    } catch (err) {
      logger.error(`Error creating directory ${path}:`, err);
      response += `❗ ${path}\n`;
    }
  }
  return response;  
};

export const MakeDirectoryComponentRegister: MacroComponentDefinition<typeof MakeDirectory> = { 
  component: MakeDirectory,
  name: 'mkdir',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'mkdir',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'create', 'make', 'dir', 'folder'],
  tools: [{
    type: "function",
    function: {
      name: "mkdir",
      description: "Creates directories at the specified paths",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            description: "Array of directory paths to create",
            items: {
              type: "string"
            }
          }
        },
        required: ["paths"]
      }
    }
  }]
};
