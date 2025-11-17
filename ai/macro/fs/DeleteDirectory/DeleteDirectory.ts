import { promises as fs } from 'fs';
import { DeleteDirectoryProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

export const DeleteDirectory: Macro<string, DeleteDirectoryProps> = async (
  props: DeleteDirectoryProps,
  state: ChatState
) => {    
  let response = '';
  const { paths } = props;
  for(const path of paths) {
    try {
      await fs.rmdir(path.trim());
      response += `✅ ${path}\n`;
    } catch (err) {
      logger.error(`Error deleting directory ${path}:`, err);
      response += `❗ ${path}\n`;
    }
  }
  return response;  
};

export const DeleteDirectoryComponentRegister: MacroComponentDefinition<typeof DeleteDirectory> = { 
  component: DeleteDirectory,
  name: 'rmdir',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'rmdir',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'delete', 'remove', 'dir', 'folder'],
  tools: [{
    type: "function",
    function: {
      name: "rmdir",
      description: "Removes directories at the specified paths",
      icon: "delete_sweep",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            description: "Array of directory paths to remove",
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
