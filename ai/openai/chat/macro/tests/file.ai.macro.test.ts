import fs from 'fs';
import { 
  ReadFile, 
  WriteFile,
  ListDirectory,
  PathInfo,
  ExtractFile,
  InsertSnippet
} from '../file.ai.macro';
import TestChatState from './mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactor/types/chat.types';
import logger from '@reactory/server-core/logging';

describe('file utilities', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({ macros: [] });    
  });

  describe("Directory Read/Write", () => { 
    test('Reads the contents of a directory and returns it as a text list', async () => {    
      const filePath = __dirname;
      const result = await ListDirectory([filePath, 'true', '*', 'text'], chatState);
      expect(result.trim()).toBeTruthy();
    });

    test('Reads the contents of a directory and returns it as a JSON list', async () => { 
      const filePath = __dirname;
      const result = await ListDirectory([filePath, 'true', '*', 'json'], chatState);    
      expect(result.trim()).toBeTruthy();
    });
  });

  describe("File Read/Write & Info", () => {
    test('returns the path info of a file', async () => { 
      const filePath = require.resolve('./samples/01.txt');
      const result = await PathInfo([filePath], chatState);
      expect(result).toBeTruthy();
    });

    test('returns the contents of a file as a string, formatted with backticks', async () => {
      const expectedString = `\`\`\`txt\ncontents of file\n\`\`\``.trim();
      const filePath = require.resolve('./samples/01.txt');
      const result = await ReadFile([filePath], chatState);
      expect(result.trim()).toEqual(expectedString);
    });

    test('Writes a string to a file, formatted without backticks', async () => {
      const dataRoot = (process.env as Reactory.Server.ReactoryEnvironment).APP_DATA_ROOT;
      const filePath = `${dataRoot}/tmp/macro-output-test-file.txt`;
      if (!fs.existsSync(`${dataRoot}/tmp`)) fs.mkdirSync(`${dataRoot}/tmp/`)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      const mockString = `\`\`\`txt\nstring to write to file\n\`\`\``.trim();
      const response = await WriteFile([filePath, mockString], chatState);
      expect(response).toEqual(`File was written successfully at ${filePath}`);
      const result = fs.readFileSync(filePath, 'utf-8').toString();    
      expect(result).toEqual('string to write to file');
    });

    test('Reads a portion of a file using ExtractFile', async () => {
      const filePath = require.resolve('./samples/03.txt');
      const result = await ExtractFile([filePath, '1', '2'], chatState);
      expect(result.trim()).toEqual('```txt\nLine 2 Content\n```');
    });

    test('should insert a snippet into a file at the specified line', async () => {
      const path = require.resolve('./samples/03.txt');      
      const data = `Line 1 Content\nLine 2 Content\nLine 3 Content`;
      before(() => {
        if(fs.existsSync(path)) fs.unlinkSync(path);
        fs.writeFileSync(path, data, 'utf-8');
      });

      after(() => {
        //reset the file
        if (fs.existsSync(path)) fs.unlinkSync(path);
        fs.writeFileSync(path, data, 'utf-8');
      });

      const expectedContent = 'Line 1 Content\nSnippet\nLine 3 Content';
      const snippet = 'Snippet';
      const result = await InsertSnippet([path, '2', '', snippet], chatState);
      // Re-read the file to check its contents
      const modifiedContent = fs.readFileSync(path, 'utf-8');

      expect(result).toBe(`Snippet inserted into ${path} successfully.`);
      expect(modifiedContent).toBe(expectedContent);

    });

    test('should replace lines in a file with the snippet', async () => {
      const path = require.resolve('./samples/03.txt');
      const originalContent = 'Line 1\nLine 2\nLine 3\nLine 4';
      const expectedContent = 'Line 1\nSnippet\nLine 4';
      const snippet = 'Snippet';
      const result = await InsertSnippet([path, '2', '3', snippet], chatState);

      // Re-read the file to check its contents
      const modifiedContent = await fs.readFileSync(path, 'utf-8');

      expect(result).toBe(`Snippet inserted into ${path} successfully.`);
      expect(modifiedContent).toBe(expectedContent);
    });

    test('should handle file read/write errors', async () => {
      const path = './nonexistent.txt';
      const snippet = 'Snippet';

      const result = await InsertSnippet([path, '2', '', snippet], chatState);

      expect(result).toMatch(`Error writing file at ${path}`);
    });
  })
});