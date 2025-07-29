import { promises as fs } from 'fs';
import { InsertSnippetProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

export const InsertSnippet: Macro<string, InsertSnippetProps> = async (
  props: InsertSnippetProps,
  state: ChatState
) => {
  const { path, start, end, snippet } = props;
  try {
    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    const lines = data.split('\n');
    const startLine = parseInt(start);
    const endLine = end ? parseInt(end) : startLine;
    const modifiedLines = [
      ...lines.slice(0, startLine - 1),
      snippet,
      ...lines.slice(endLine)
    ];
    const modifiedData = modifiedLines.join('\n');
    await fs.writeFile(path.trim(), modifiedData, 'utf-8');
    return `Snippet inserted into ${path} successfully.`;
  } catch (err) {
    logger.error(`Error writing file at ${path}:`, err);
    return `Error writing file at ${path}`;
  }
};

export const InsertSnippetComponentRegister: MacroComponentDefinition<typeof InsertSnippet> = {
  component: InsertSnippet,
  name: 'insertText',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'insertText',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'file', 'insert', 'snippet', 'replace', 'insert'],
  tools: [{
    type: "function",
    function: {
      name: "insertText",
      description: "Inserts or replaces text in a file at specified line positions",
      icon: "content_paste",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to modify"
          },
          start: {
            type: "string",
            description: "Start line number (1-based)"
          },
          end: {
            type: "string",
            description: "End line number (1-based, optional - defaults to start)"
          },
          snippet: {
            type: "string",
            description: "The text snippet to insert"
          }
        },
        required: ["path", "start", "snippet"]
      }
    }
  }],
};
