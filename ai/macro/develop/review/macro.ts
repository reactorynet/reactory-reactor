import pathModule from 'path';
import os from 'os';
import { promises as fs, readFileSync, existsSync, statSync } from 'fs';
import git from '../git';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { 
  FileMacros, 
  RemoveDirectory, 
  ReadFile as fileIn,
  ListDirectory as dirIn, 
  WriteFile as fileOut } from '../../fs/macro';
import { getAIResponse, createPrompt, extractResponse } from '@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory';
import { template } from 'lodash';
import { CodeReviewFileProps, CodeReviewProps, CodeReviewFileMacroResult, CodeReviewMacroResult } from './types';
import { Default as DefaultReviewSpecification } from './specifications';
import { strongRandom } from 'utils';
import logger from '@reactory/server-core/logging';

/**
 * Checks if a path is directory
 * @param path 
 * @returns 
 */
export const isDirectory = (path: string): boolean => {
  try {
    const stat = statSync(path);
    return stat.isDirectory();
  } catch (error) {
    // Handle error if the path does not exist or there was an issue accessing it
    console.error(`Error checking if ${path} is a directory: ${error}`);
    return false;
  }
};

/**
 * Macro that performs a review on a file using a set of specifications
 * @param props 
 * @param state 
 * @returns 
 */
export const CodeReviewFile: Macro<CodeReviewFileMacroResult, CodeReviewFileProps> = async (
  props: CodeReviewFileProps,
  state: ChatState): Promise<CodeReviewFileMacroResult> => {
  
  const startTime = Date.now();
  const {
    path, 
    specs, 
    target = 'inline',
    targetPath
  } = props;

  const {
    ai,
    macros,
    modelId,
    history,
    rl
  } = state;

  if (!path || path.trim().length === 0) {
    return {
      success: false,
      error: 'A request for a code review requires a valid path to a file',
      tool: 'codeReviewFile',
      params: props
    };
  }

  let $path = path.trim();

  // `rl` is the CLI readline interface and is only present on a ChatState built
  // by the interactive CLI. This macro is also reached as a tool call from the
  // conversation service, where there is no readline — an unguarded write threw
  // "Cannot read properties of undefined (reading 'write')" and failed the
  // review before it started.
  rl?.write(`Reviewing ${$path} - please wait...\n`);

  if ($path.indexOf('${') > -1) $path = template($path)({ os, pathModule, process, state });
  
  if (!existsSync($path)) {
    return {
      success: false,
      error: `The path "${$path}" does not exist`,
      tool: 'codeReviewFile',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: $path,
        target
      }
    };
  }
  
  let specificationContent: string = "";

  if (specs && existsSync(specs)) {
    specificationContent = readFileSync(specs).toString();
  }
  
  // Registry names are camelCase ('readFile', not 'ReadFile'). This looked up
  // 'ReadFile', never matched, and returned "No file input macro found" for
  // every call — CodeReviewFile could not review anything.
  const fileIn = FileMacros.find(macro => macro.name === 'readFile');

  if (!fileIn) {
    return {
      success: false,
      error: 'No file input macro found',
      tool: 'codeReviewFile',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: $path,
        target
      }
    };
  }

  try {
    const fileContents = await fileIn.component({ path: $path }, state);
    const fileStats = await fs.stat($path);
    
    const prompt = createPrompt(
      modelId,
      `Write code review for: \n${fileContents}\n using the specifications :\n ${specificationContent}`,
      history,
      'system'
    );

    const result = await getAIResponse(ai, prompt, state);
    const updatedResponse = JSON.parse(JSON.stringify(result));
    // extractResponse returns the *message object*, so take its content. This
    // used to keep the whole message, which put `{ role, content }` into
    // `data.review` and left `reviewLength` undefined (message objects have no
    // `.length`). CodeReview below already did this correctly.
    const reviewMessage = extractResponse(updatedResponse, prompt.messages[0].content);
    const review: string =
      typeof reviewMessage === 'string' ? reviewMessage : reviewMessage?.content ?? '';
    const executionTime = Date.now() - startTime;
    const reviewLength = review.length;
    let writtenToFile = false;

    if (target === 'inline') {
      // Store in chat state for AI reference
      if (!state.vars) {
        state.vars = {};
      }
      state.vars.lastCodeReviewFile = {
        path: $path,
        review,
        target,
        specs: specs || null,
        fileSize: fileStats.size,
        reviewLength,
        lastReviewed: new Date()
      };

      // Log review for security
      logger.info(`CodeReviewFile macro executed: ${$path} by user: ${state.user?.id || 'unknown'}, target: ${target}, reviewLength: ${reviewLength}`);

      return {
        success: true,
        data: {
          path: $path,
          review,
          target,
          specs: specs || undefined,
          writtenToFile,
          fileSize: fileStats.size,
          reviewLength
        },
        tool: 'codeReviewFile',
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          path: $path,
          target,
          reviewLength
        },
        instructions: `
## Code Review Results

Successfully completed code review for: **${pathModule.basename($path)}**

### Review Information:
- **File Path**: ${$path}
- **File Size**: ${(fileStats.size / 1024).toFixed(2)}KB
- **Target**: ${target}
- **Review Length**: ${reviewLength} characters
- **Specifications**: ${specs ? 'Used' : 'None'}
- **Written to File**: ${writtenToFile ? 'Yes' : 'No'}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **review**: Complete code review in markdown format
- **path**: Full file path that was reviewed
- **target**: Output target type used
- **specs**: Specification file path (if used)
- **writtenToFile**: Whether review was saved to file
- **fileSize**: Size of the reviewed file
- **reviewLength**: Length of the review content

### State Variables Available:
- lastCodeReviewFile: Complete review information for future reference

### Usage:
- Use \`review\` for the complete code review content
- Use \`path\` to identify the reviewed file
- Use \`fileSize\` to understand file complexity
- Use \`reviewLength\` to assess review depth
- Use \`data\` for comprehensive review information
        `
      };
    }

    if (target === 'file') {
      if (!targetPath) {
        return {
          success: false,
          error: 'Target path is required when target is "file"',
          tool: 'codeReviewFile',
          params: props,
          metadata: {
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
            user: state.user?.id,
            path: $path,
            target
          }
        };
      }

      // Same casing fix as the readFile lookup above, and resolved from the
      // imported FileMacros registry rather than state.macros: writing the
      // review out is this macro's own dependency, not something the caller
      // needs to have registered on the chat state.
      const fileOut = FileMacros.find(macro => macro.name === 'writeFile');
      if (!fileOut) {
        return {
          success: false,
          error: 'No file output macro found',
          tool: 'codeReviewFile',
          params: props,
          metadata: {
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
            user: state.user?.id,
            path: $path,
            target
          }
        };
      }

      await fileOut.component({ path: targetPath, content: review, mode: 'overwrite' }, state);
      writtenToFile = true;

      // Store in chat state for AI reference
      if (!state.vars) {
        state.vars = {};
      }
      state.vars.lastCodeReviewFile = {
        path: $path,
        review,
        target,
        targetPath,
        specs: specs || null,
        fileSize: fileStats.size,
        reviewLength,
        writtenToFile,
        lastReviewed: new Date()
      };

      // Log review for security
      logger.info(`CodeReviewFile macro executed: ${$path} by user: ${state.user?.id || 'unknown'}, target: ${target}, targetPath: ${targetPath}, reviewLength: ${reviewLength}`);

      return {
        success: true,
        data: {
          path: $path,
          review,
          target,
          targetPath,
          specs: specs || undefined,
          writtenToFile,
          fileSize: fileStats.size,
          reviewLength
        },
        tool: 'codeReviewFile',
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          path: $path,
          target,
          reviewLength
        },
        instructions: `
## Code Review Results

Successfully completed code review for: **${pathModule.basename($path)}**

### Review Information:
- **File Path**: ${$path}
- **File Size**: ${(fileStats.size / 1024).toFixed(2)}KB
- **Target**: ${target}
- **Target Path**: ${targetPath}
- **Review Length**: ${reviewLength} characters
- **Specifications**: ${specs ? 'Used' : 'None'}
- **Written to File**: ${writtenToFile ? 'Yes' : 'No'}
- **Execution Time**: ${executionTime}ms

### Available Data:
- **review**: Complete code review in markdown format
- **path**: Full file path that was reviewed
- **target**: Output target type used
- **targetPath**: File where review was saved
- **specs**: Specification file path (if used)
- **writtenToFile**: Whether review was saved to file
- **fileSize**: Size of the reviewed file
- **reviewLength**: Length of the review content

### State Variables Available:
- lastCodeReviewFile: Complete review information for future reference

### Usage:
- Use \`review\` for the complete code review content
- Use \`path\` to identify the reviewed file
- Use \`targetPath\` to locate the saved review
- Use \`fileSize\` to understand file complexity
- Use \`reviewLength\` to assess review depth
- Use \`data\` for comprehensive review information
        `
      };
    }

    return {
      success: false,
      error: `Invalid target type: ${target}. Use 'inline' or 'file'`,
      tool: 'codeReviewFile',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: $path,
        target
      }
    };

  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in CodeReviewFile macro for path ${$path}:`, error);
    
    return {
      success: false,
      error: `Code review failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'codeReviewFile',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        path: $path,
        target
      }
    };
  }
};

/**
 * Registry entry for the CodeReviewFile macro
 */
export const CodeReviewFileComponentRegister: MacroComponentDefinition<typeof CodeReviewFile> = {
  nameSpace: 'reactor',
  name: 'CodeReviewFile',
  version: '1.0.0',
  component: CodeReviewFile,
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  roles: ['DEVELOPER', 'ADMIN'],
  stem: 'reviewFile',
  tags: ['code', 'review', 'development', 'file'],
  tools: [{
    type: "function",
    function: {
      name: "CodeReviewFile",
      description: "Performs a code review on a single file using specifications",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to review"
          },
          specs: {
            type: "string",
            description: "Path to specification file (optional)"
          },
          target: {
            type: "string",
            enum: ["inline", "file"],
            description: "Target output type - 'inline' or 'file'"
          },
          targetPath: {
            type: "string",
            description: "Target file path when target is 'file'"
          }
        },
        required: ["path"]
      }
    }
  }]
}

/**
 * Performs a code review of the give folder and returns the results.
 * @param props 
 * @param state 
 */
export const CodeReview: Macro<string, CodeReviewProps> = async (
  props: CodeReviewProps,
  state: ChatState) => {

  const {
    path, 
    specs,
    target = 'inline',
    targetPath,
    throttle = '500',
    verbose = 'false'
  } = props;
  const {
    ai,
    macros,
    modelId,
    history,
  } = state;

  let $path = path;

  if($path.includes('${')) $path = template($path)({ os, pathModule, process, state });

  if(!$path) return 'A request for a review requires a valid path to a folder';
  if(!existsSync($path)) return `The path ${$path} does not exist`;

  // The default specification is the `Default` preset in ./specifications, not
  // a markdown file. This used to `require.resolve('./review.specifications.
  // default.md')` — a file that does not exist in the package, so every call to
  // CodeReview threw MODULE_NOT_FOUND before it could review anything. A caller
  // -supplied `specs` file still wins.
  let specificationContent: string = JSON.stringify(DefaultReviewSpecification, null, 2);
  if (specs && existsSync(specs)) specificationContent = readFileSync(specs).toString();

  
  // we get the directory contents using the dirIn macro. It resolves a
  // structured result now; this used to JSON.parse() its return value, which
  // threw `"[object Object]" is not valid JSON` on every call since the macro
  // stopped returning a JSON string.
  const listing = await dirIn(
    { path: $path, recursive: true, pattern: '*', format: 'json' },
    state
  );

  if (!listing.success) {
    return `Could not list the contents of ${$path}: ${listing.error}`;
  }

  // Entries come back in ListDirectory's shorthand form: n=name, s=size,
  // d=isDirectory, p=path.
  const dirContents = listing.data?.items ?? [];

  let question = `Write a review on file structure for the following directory: ${$path}
  \`\`\`txt
  ${dirContents.map(f => `${f.n}`).join('\n')}\n\n
  \`\`\`
  `;
  const prompt = createPrompt(
    modelId,
    question,
    history,
    'system'
  );
  
  const fileReviewResult = await getAIResponse(state.ai, prompt, state);

  // Clone the response to avoid mutating the original object
  const updatedResponse = JSON.parse(JSON.stringify(fileReviewResult));

  // Access message object
  let message = extractResponse(updatedResponse, question);

  state.vars.review = message.content;

  // we iterate over the directory contents and perform a code review on each file
  let lastReviewTS = Date.now();

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const file of dirContents) {
    const doReview = async () => {
      // Shorthand keys: n=name, s=size, d=isDirectory.
      const size = file.s ?? 0;
      if (size > 0 && file.d !== true) {
        if (size < 100000) {
          const filePath = pathModule.join($path, file.n);
          const fileResult = await CodeReviewFile({ path: filePath, specs }, state);
          // CodeReviewFile resolves a structured result; interpolating it
          // directly wrote "[object Object]" into the accumulated review for
          // every file in the directory.
          state.vars.review = fileResult.success
            ? `${state.vars.review}\n\n${fileResult.data?.review ?? ''}`
            : `${state.vars.review}\n\nCould not review ${file.n}: ${fileResult.error}`;
        } else {
          state.vars.review = `${state.vars.review}\n\n${file.n} is too large to review - Skipping review`;
        }
      } else {
        state.vars.review =  `${state.vars.review}\n\n No content found for file ${file.n} - Skipping review`;
      }
    }

    const now = Date.now();
    const THROTTLE = parseInt(throttle);
    if (now - lastReviewTS < THROTTLE) {
      await delay(THROTTLE - (now - lastReviewTS));
    }

    await doReview();
    lastReviewTS = Date.now();
  }

  let finalPrompt = createPrompt(
    modelId,
    `Summarize and format the review generated below:\n\n${state.vars.review}`,
    history,
    'system'
  );

  const result = await getAIResponse(ai, finalPrompt, state);

  // Clone the response to avoid mutating the original object
  const finalResponse = JSON.parse(JSON.stringify(result));

  // Access message object
  const finalMessage = extractResponse(finalResponse, finalPrompt.messages[0].content);
  // we return the final message & overwite the review file with the updated review
  if(target === 'inline') return finalMessage.content;
  if(target === 'file') { 
    await fileOut({ path: pathModule.join($path, 'reactor_code_review.md'), content: finalMessage.content }, state);
  }
  return finalMessage.content;
}

/**
 * Registry entry for the CodeReview macro
 */
export const CodeReviewComponentRegister: MacroComponentDefinition<typeof CodeReview> = { 
  nameSpace: 'reactor',
  name: 'CodeReview',
  version: '1.0.0',
  roles: ['DEVELOPER', 'ADMIN'],
  component: CodeReview,
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'review',
  tags: ['code', 'review', 'development', 'file', 'directory'],
  tools: [{
    type: "function",
    function: {
      name: "CodeReview",
      description: "Performs a comprehensive code review on a directory and its files",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the directory to review"
          },
          specs: {
            type: "string",
            description: "Path to specification file (optional)"
          },
          target: {
            type: "string",
            enum: ["inline", "file"],
            description: "Target output type - 'inline' or 'file'"
          },
          targetPath: {
            type: "string",
            description: "Target file path when target is 'file'"
          },
          throttle: {
            type: "string",
            description: "Throttle delay between reviews in milliseconds"
          },
          verbose: {
            type: "string",
            description: "Enable verbose output"
          }
        },
        required: ["path"]
      }
    }
  }]
}


/**
 * Registry of development macros
 */
export const DevelopmentMacros: MacroComponentDefinition<Macro<unknown>>[] = [
  CodeReviewComponentRegister,
  CodeReviewFileComponentRegister,
];