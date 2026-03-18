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
    if (!path || !path.trim()) {
      return 'Error: path is required';
    }
    if (!start) {
      return 'Error: start line number is required';
    }
    const startLine = parseInt(start, 10);
    if (isNaN(startLine) || startLine < 1) {
      return `Error: start must be a positive integer, got "${start}"`;
    }

    const data: string = (await fs.readFile(path.trim(), 'utf-8')).toString();
    // Normalise line endings to LF so line-number arithmetic is consistent;
    // the original ending style is restored on write.
    const hasCRLF = data.includes('\r\n');
    const normalised = hasCRLF ? data.replace(/\r\n/g, '\n') : data;
    const lines = normalised.split('\n');

    if (startLine > lines.length + 1) {
      return `Error: start line ${startLine} is beyond end of file (${lines.length} lines)`;
    }

    let endLine: number;
    if (end) {
      endLine = parseInt(end, 10);
      if (isNaN(endLine) || endLine < startLine) {
        return `Error: end must be an integer >= start (${startLine}), got "${end}"`;
      }
      if (endLine > lines.length) {
        return `Error: end line ${endLine} is beyond end of file (${lines.length} lines)`;
      }
    } else {
      // INSERT mode: no end given — preserve the original line at startLine.
      // Using startLine - 1 (0-based) so lines.slice(endLine) starts at the
      // original startLine, keeping it in the output after the snippet.
      endLine = startLine - 1;
    }

    const modifiedLines = [
      ...lines.slice(0, startLine - 1),
      snippet,
      ...lines.slice(endLine),
    ];
    const modifiedData = hasCRLF
      ? modifiedLines.join('\r\n')
      : modifiedLines.join('\n');
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
      description: "Inserts or replaces text in a file at specified line positions. " +
        "When only 'start' is provided the snippet is inserted BEFORE that line (the original line is preserved). " +
        "When both 'start' and 'end' are provided the lines in [start, end] are replaced by the snippet.",
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
