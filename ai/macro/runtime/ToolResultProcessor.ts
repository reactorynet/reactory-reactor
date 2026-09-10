import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '@reactory/server-core/logging';
import Reactory from '@reactorynet/reactory-core';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

export interface ToolResultProcessorOptions {
  /** Maximum output size in characters/bytes before offloading to file. Default: 20000 */
  maxOutputSize?: number;
  /** Directory path to save output file to. Defaults to state workspace or os.tmpdir() */
  outputDir?: string;
  /** Optional custom file prefix, defaults to toolName */
  filePrefix?: string;
  /**
   * Per-field character budget used when curating an oversized `data` object.
   * Any string/array/object field whose stringified size exceeds this budget is
   * replaced with a compact `{ truncated: true, ... }` placeholder instead of
   * being kept in full. Default: 2000.
   */
  fieldBudget?: number;
}

export interface ProcessedToolResult {
  /** The processed (and potentially truncated) tool result */
  result: any;
  /** Whether the result was offloaded to disk and truncated */
  outputTruncated: boolean;
  /** Path to saved output file if truncated */
  outputFile?: string;
  /** Size of total output file in bytes if truncated */
  outputSize?: number;
}

export class ToolResultProcessor {
  /** Default per-field character budget applied when curating a `data` object. */
  private static readonly DEFAULT_FIELD_BUDGET = 2000;

  /**
   * Curates an oversized `data` object field-by-field instead of blanket-spreading
   * it back in. Any own key whose stringified value exceeds `fieldBudget` characters
   * is replaced with a compact `{ truncated: true, ... }` placeholder describing the
   * shape and size of what was removed (item count for arrays, char length for
   * strings, key count for nested objects). Small/short fields pass through untouched.
   *
   * This generalises the legacy `stdout`/`content` special-casing to ANY field
   * shape - results arrays, node arrays, duplicated code-block strings, etc. - so
   * every macro benefits, not just the ones whose bloat happens to live under one
   * of those two literal keys.
   */
  private static curateDataObject(
    data: Record<string, any>,
    noticeMessage: string,
    fieldBudget?: number
  ): Record<string, any> {
    const budget = fieldBudget && fieldBudget > 0 ? fieldBudget : ToolResultProcessor.DEFAULT_FIELD_BUDGET;
    const curated: Record<string, any> = {};
    // Legacy fields historically collapsed to the flat notice string rather than a
    // structured placeholder, so consumers that render/concatenate them as plain
    // text (e.g. shell output panes, file content viewers) keep working unchanged.
    const legacyStringFields = new Set(['stdout', 'content']);

    for (const [key, value] of Object.entries(data)) {
      if (legacyStringFields.has(key) && typeof value === 'string' && value.length > budget) {
        curated[key] = noticeMessage;
        continue;
      }
      curated[key] = ToolResultProcessor.curateField(value, budget, noticeMessage);
    }

    return curated;
  }

  private static curateField(value: any, budget: number, noticeMessage: string): any {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (value.length <= budget) return value;
      return {
        truncated: true,
        type: 'string',
        length: value.length,
        preview: value.slice(0, Math.min(200, budget)),
        notice: noticeMessage,
      };
    }

    if (Array.isArray(value)) {
      let size = 0;
      try {
        size = JSON.stringify(value).length;
      } catch {
        size = value.length * budget;
      }
      if (size <= budget) return value;
      return {
        truncated: true,
        type: 'array',
        itemCount: value.length,
        approxSize: size,
        preview: value.slice(0, 3),
        notice: noticeMessage,
      };
    }

    if (typeof value === 'object') {
      let size = 0;
      try {
        size = JSON.stringify(value).length;
      } catch {
        size = budget + 1;
      }
      if (size <= budget) return value;
      return {
        truncated: true,
        type: 'object',
        keyCount: Object.keys(value).length,
        approxSize: size,
        notice: noticeMessage,
      };
    }

    return value;
  }

  /**
   * Universal default max output character limit for tool responses.
   * Can be configured globally via REACTORY_TOOL_MAX_OUTPUT_SIZE environment variable.
   */
  public static getDefaultMaxOutputSize(): number {
    if (process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE) {
      const parsed = parseInt(process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 20000;
  }

  /**
   * Processes any tool execution result. If the stringified representation of the result
   * exceeds maxOutputSize, the full payload is saved to a file, and the returned object
   * or string is truncated and augmented with file details and AI guidance.
   */
  public static process(
    toolName: string,
    params: any,
    rawResult: any,
    state?: ChatState,
    context?: Reactory.Server.IReactoryContext,
    options?: ToolResultProcessorOptions
  ): ProcessedToolResult {
    if (rawResult === null || rawResult === undefined) {
      return { result: rawResult, outputTruncated: false };
    }

    const maxOutputSize = options?.maxOutputSize && options.maxOutputSize > 0
      ? options.maxOutputSize
      : ToolResultProcessor.getDefaultMaxOutputSize();

    // Convert result to string payload to measure size
    let payloadString = '';
    if (typeof rawResult === 'string') {
      payloadString = rawResult;
    } else {
      try {
        payloadString = JSON.stringify(rawResult, null, 2);
      } catch (err) {
        payloadString = String(rawResult);
      }
    }

    // If within safe size limits, return unmodified
    if (payloadString.length <= maxOutputSize) {
      return { result: rawResult, outputTruncated: false };
    }

    // Determine target directory for file offloading
    let targetDir = options?.outputDir;
    if (!targetDir) {
      const userHome = (context as any)?.user?.home || (state?.context as any)?.user?.home;
      if (userHome && fs.existsSync(userHome)) {
        targetDir = path.join(userHome, 'workspace');
        if (!fs.existsSync(targetDir)) {
          try {
            fs.mkdirSync(targetDir, { recursive: true });
          } catch (e) {
            targetDir = os.tmpdir();
          }
        }
      } else {
        targetDir = os.tmpdir();
      }
    }

    const timestamp = Date.now();
    const prefix = options?.filePrefix || toolName || 'tool';
    const isJson = typeof rawResult !== 'string';
    const ext = isJson ? '.json' : '.log';
    const outputFile = path.join(targetDir, `${prefix}-output-${timestamp}${ext}`);
    const outputSize = Buffer.byteLength(payloadString, 'utf8');

    try {
      fs.writeFileSync(outputFile, payloadString, { encoding: 'utf8' });
      logger.info(`[ToolResultProcessor] Offloaded ${outputSize} bytes of output from tool '${toolName}' to ${outputFile}`);
    } catch (writeError: any) {
      logger.error(`[ToolResultProcessor] Failed to write output file ${outputFile}: ${writeError.message}`);
    }

    const noticeMessage = `Output size (${outputSize} bytes / ${payloadString.length} characters) exceeds maximum inline threshold (${maxOutputSize} characters). Full result saved to: ${outputFile}. Please use targeted search tools (such as snip, readFile, grep, searchContent, or sliceVariable) to inspect specific sections of the file, or refine your tool parameters/query to reduce output volume.`;
    const instructionsText = `Tool '${toolName}' produced large output (${outputSize} bytes). Complete payload saved to file: ${outputFile}. Use targeted inspection tools (e.g. snip, readFile, grep) to inspect specific sections or refine parameters to reduce output size.`;

    let processedResult: any;

    if (typeof rawResult === 'string') {
      processedResult = noticeMessage;
    } else if (typeof rawResult === 'object') {
      // Clone result to avoid mutating caller object unexpectedly
      processedResult = Array.isArray(rawResult) ? [...rawResult] : { ...rawResult };

      if (processedResult.data !== undefined) {
        // Structured macro result
        if (typeof processedResult.data === 'object' && processedResult.data !== null) {
          processedResult.data = ToolResultProcessor.curateDataObject(
            processedResult.data,
            noticeMessage,
            options?.fieldBudget
          );
          processedResult.data.outputFile = outputFile;
          processedResult.data.outputSize = outputSize;
          processedResult.data.outputTruncated = true;
          processedResult.data.summary = noticeMessage;
        } else if (typeof processedResult.data === 'string') {
          processedResult.data = noticeMessage;
        }

        processedResult.instructions = processedResult.instructions
          ? `${processedResult.instructions}\n\n${instructionsText}`
          : instructionsText;
      } else {
        // Plain object or array payload
        processedResult = {
          outputTruncated: true,
          outputFile,
          outputSize,
          message: noticeMessage,
          instructions: instructionsText,
          tool: toolName,
          params
        };
      }
    } else {
      processedResult = noticeMessage;
    }

    return {
      result: processedResult,
      outputTruncated: true,
      outputFile,
      outputSize,
    };
  }
}

export default ToolResultProcessor;
