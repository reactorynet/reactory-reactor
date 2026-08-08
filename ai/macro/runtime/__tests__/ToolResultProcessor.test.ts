import fs from 'fs';
import path from 'path';
import os from 'os';
import ToolResultProcessor from '../ToolResultProcessor';

describe('ToolResultProcessor', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    createdFiles.forEach(file => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (e) {}
      }
    });
    createdFiles.length = 0;
  });

  it('returns raw result unmodified when under maxOutputSize', () => {
    const rawResult = { success: true, data: 'small output' };
    const processed = ToolResultProcessor.process('testTool', {}, rawResult, undefined, undefined, { maxOutputSize: 20000 });

    expect(processed.outputTruncated).toBe(false);
    expect(processed.outputFile).toBeUndefined();
    expect(processed.result).toEqual(rawResult);
  });

  it('offloads large string result to disk and replaces string with notice message', () => {
    const largeString = 'A'.repeat(5000);
    const processed = ToolResultProcessor.process('testTool', {}, largeString, undefined, undefined, { maxOutputSize: 100 });

    expect(processed.outputTruncated).toBe(true);
    expect(processed.outputFile).toBeDefined();
    createdFiles.push(processed.outputFile!);

    expect(fs.existsSync(processed.outputFile!)).toBe(true);
    expect(fs.readFileSync(processed.outputFile!, 'utf8')).toBe(largeString);

    expect(typeof processed.result).toBe('string');
    expect(processed.result).toContain('Output size (5000 bytes / 5000 characters) exceeds maximum inline threshold (100 characters)');
    expect(processed.result).toContain(processed.outputFile);
    expect(processed.result).toContain('targeted search tools');
  });

  it('offloads large structured macro result ({ success, data, instructions }) and updates data and instructions', () => {
    const largeData = { stdout: 'B'.repeat(3000), details: 'large' };
    const rawResult = {
      success: true,
      data: largeData,
      instructions: 'Original instructions'
    };

    const processed = ToolResultProcessor.process('shell', { command: 'test' }, rawResult, undefined, undefined, { maxOutputSize: 100 });

    expect(processed.outputTruncated).toBe(true);
    expect(processed.outputFile).toBeDefined();
    createdFiles.push(processed.outputFile!);

    expect(fs.existsSync(processed.outputFile!)).toBe(true);

    const result = processed.result;
    expect(result.success).toBe(true);
    expect(result.data.outputTruncated).toBe(true);
    expect(result.data.outputFile).toBe(processed.outputFile);
    expect(result.data.stdout).toContain('exceeds maximum inline threshold');
    expect(result.instructions).toContain('Original instructions');
    expect(result.instructions).toContain('Tool \'shell\' produced large output');
  });

  it('offloads large plain object payload and returns summary object', () => {
    const largeObject = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item_${i}` })) };
    const processed = ToolResultProcessor.process('listItems', {}, largeObject, undefined, undefined, { maxOutputSize: 200 });

    expect(processed.outputTruncated).toBe(true);
    expect(processed.outputFile).toBeDefined();
    createdFiles.push(processed.outputFile!);

    expect(fs.existsSync(processed.outputFile!)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(processed.outputFile!, 'utf8'));
    expect(saved.items.length).toBe(500);

    expect(processed.result.outputTruncated).toBe(true);
    expect(processed.result.outputFile).toBe(processed.outputFile);
    expect(processed.result.message).toContain('exceeds maximum inline threshold');
    expect(processed.result.instructions).toContain('Tool \'listItems\' produced large output');
  });

  it('respects REACTORY_TOOL_MAX_OUTPUT_SIZE environment variable', () => {
    const prevEnv = process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE;
    process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE = '50';

    try {
      const mediumString = 'C'.repeat(200);
      const processed = ToolResultProcessor.process('envTool', {}, mediumString);

      expect(processed.outputTruncated).toBe(true);
      expect(processed.outputFile).toBeDefined();
      createdFiles.push(processed.outputFile!);
    } finally {
      if (prevEnv === undefined) delete process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE;
      else process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE = prevEnv;
    }
  });
});
