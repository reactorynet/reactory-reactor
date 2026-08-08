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
          processedResult.data = {
            ...processedResult.data,
            outputFile,
            outputSize,
            outputTruncated: true,
            summary: noticeMessage,
          };
          if (typeof processedResult.data.stdout === 'string') {
            processedResult.data.stdout = noticeMessage;
          }
          if (typeof processedResult.data.content === 'string') {
            processedResult.data.content = noticeMessage;
          }
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
