import fs from 'fs';
import { 
  ReadFile, 
  WriteFile,
  ListDirectory,
} from '../file.ai.macro';
import TestChatState from './mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactor/types/chat.types';

describe('file utilities', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({ macros: [] });
    process.env.APP_DATA_ROOT = `${__dirname}/samples`;  
  });

  describe('ReadFile', () => {
    test('returns the contents of a file as a string, formatted with backticks', async () => {
      const expectedString = `\`\`\`txt\ncontents of file\n\`\`\``.trim();
      const filePath = require.resolve('./samples/01.txt');
      const result = await ReadFile([filePath], chatState);
      expect(result.trim()).toEqual(expectedString);
    });
  });

  describe('WriteFile', () => {
    test('Writes a string to a file, formatted without backticks', async () => {
      const dataRoot = (process.env as Reactory.Server.ReactoryEnvironment).APP_DATA_ROOT;
      const filePath = `${dataRoot}/tmp/macro-output-test-file.txt}`;
      if (!fs.existsSync(`${dataRoot}/tmp`)) fs.mkdirSync(`${dataRoot}/tmp/`)      
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      const mockString = `\`\`\`txt\nstring to write to file\n\`\`\``.trim();
      const response = await WriteFile([filePath, mockString], chatState);
      expect(response).toEqual(`File was written successfully at ${filePath}`);
      const result = fs.readFileSync(filePath, 'utf-8').toString();
      expect(result).toEqual('string to write to file');
    });
  });

  describe("Directory Read/Write", () => { 
    test('Reads the contents of a directory and returns it as a text list', async () => {    
      const filePath = process.env.APP_DATA_ROOT;
      const result = await ListDirectory([filePath, 'true', '*', 'text'], chatState);
      expect(result.trim()).toBeTruthy();
    });
  });
});