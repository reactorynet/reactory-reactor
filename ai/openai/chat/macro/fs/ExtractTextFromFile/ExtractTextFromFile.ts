import { promises as fs } from 'fs';
import { ExtractTextFromFileProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

export const ExtractTextFromFile: Macro<string, ExtractTextFromFileProps> = async (
  props: ExtractTextFromFileProps,
  state: ChatState
) => {
  const { path, start, end } = props;
  if (isNaN(Number(start)) || isNaN(Number(end))) {
    return `Invalid parameters. Usage: @snipText(path, start, end)`;
  }
  try {
    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    const mime = path.split('.').pop() || 'txt';
    const lines = data.split('\n');
    const startLine = parseInt(start);
    const endLine = parseInt(end);
    if(endLine < startLine) return `Invalid parameters. Usage: @snipText(path, start, end) end must be larger than the start`;
    const portion = lines.slice(startLine - 1, endLine).join('\n');
    const content = `${mime}\n${portion}`;
    return `\`\`\`${content}\n\`\`\``;
  } catch (err) {
    return `Error reading file at ${path}: ${err?.message}`;
  }
};

export const ExtractFileComponentRegister: MacroComponentDefinition<typeof ExtractTextFromFile> = {
  component: ExtractTextFromFile,
  name: 'snip',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'snip',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'extract', 'portion', 'slice', 'snip'],
  tools: [{
    type: "function",
    function: {
      name: "snip",
      description: "Extracts a portion of text from a file between specified line numbers",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to extract text from"
          },
          start: {
            type: "string", 
            description: "Start line number (1-based)"
          },
          end: {
            type: "string",
            description: "End line number (1-based)"
          }
        },
        required: ["path", "start", "end"]
      }
    }
  }],
  alias: 'snip'
};
