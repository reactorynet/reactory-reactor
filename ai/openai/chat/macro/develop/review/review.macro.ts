import pathModule from 'path';
import os from 'os';
import { promises as fs, readFileSync, existsSync, mkdirSync } from 'fs';
import git from '../git';
import { ChatState, Macro } from '@reactory/server-modules/reactor/types/chat.types';
import { FileMacros, RemoveDirectory } from '../../fs/fs.macro';
import { getAIResponse, createPrompt } from '@reactory/server-modules/reactor/ai/openai/chat/questions/factory';
import { template } from 'lodash';

/**
 * Macro that performs a review on a file using a set of specifications
 * @param args 
 * @param state 
 * @returns 
 */
export const CodeReviewFile: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  
  const [
    path, 
    specs, 
    //options are inline or file
    target = 'inline',
    targetPath
  ] = args;

  const {
    ai,
    macros,
    modelId,
    history
  } = state;

  let $path = path;

  if ($path.indexOf('${') > -1) $path = template($path)({ os, pathModule, process, state });

  const SUCCESS_MESSAGE = (review: string) => `Code review completed for ${$path}:\n${review}`;
  const FAILURE_MESSAGE = (error: string) => `Code review failed for ${$path}:\n${error}`;
  
  if(!$path) return FAILURE_MESSAGE('A request for a a code review requires a valid path to a folder');
  if(!existsSync($path)) return FAILURE_MESSAGE(`The path "${$path}" does not exist`);
  
  let specificationContent: string = readFileSync(require.resolve('./review.specifications.default.md')).toString();

  if(specs && existsSync(specs)) specificationContent = readFileSync(specs).toString();
  
  const fileIn = FileMacros.find(macro => macro.name === 'ReadFile');

  if(!fileIn) return FAILURE_MESSAGE('No file input macro found');

  const fileContents = await fileIn.component([path], state);
  const prompt = createPrompt(
    modelId,
    `Write code review for: \n${fileContents}\n using the specifications :\n ${specificationContent}`,
    history,
    'system'
  );

  const result = await getAIResponse(ai, prompt, state);  
  const updatedResponse = JSON.parse(JSON.stringify(result));
  // Access message object
  const message = updatedResponse.choices[0].message;
  const review = message.content;

  if(target === 'inline') {
    return SUCCESS_MESSAGE(review);
  }

  if(target === 'file') {
    const fileOut = macros.find(macro => macro.name === 'WriteFile');
    if(!fileOut) return FAILURE_MESSAGE('No file output macro found');
    await fileOut.component([targetPath, review, 'overwrite'], state);
    return SUCCESS_MESSAGE(review);
  }
}

/**
 * Registry entry for the CodeReview macro
 */
export const CodeReviewFileComponentRegister: Reactory.IReactoryComponentDefinition<typeof CodeReviewFile> = {
  nameSpace: 'reactor',
  name: 'CodeReview',
  version: '1.0.0',
  component: CodeReviewFile,
  description: readFileSync(require.resolve('./review.file.macro.md'), 'utf-8').toString(),
  features: [],
  stem: 'review',
  tags: ['code', 'review', 'development', 'file', 'directory'],
}

/**
 * Performs a code review of the give folder and returns the results.
 * @param args 
 * @param state 
 */
export const CodeReview: Macro<string> = async (
  args: string[],
  state: ChatState) => {

  const [
    path, 
    specs,
    target = 'inline',
    targetPath,
    throttle = '500'
  ] = args;
  const {
    ai,
    macros,
    modelId,
    history,
  } = state;

  let $path = path;

  if($path.indexOf('${') > -1) $path = template($path)({ os, pathModule, process, state });

  if(!$path) return 'A request for a a code review requires a valid path to a folder';
  if(!existsSync($path)) return `The path ${$path} does not exist`;

  let specificationContent = readFileSync(require.resolve('./review.specifications.default.md'));
  if (specs && existsSync(specs)) specificationContent = readFileSync(specs);

  let fileIn: Macro<string> = null;
  let dirIn: Macro<string> = null;
  let fileOut: Macro<string> = null;


  state.macros.forEach(macro => { 
    if(macro && macro.name === 'ReadFile') {
      fileIn = macro.component as Macro<string>;
    }

    if(macro && macro.name === 'ListDirectory') {
      dirIn = macro.component as Macro<string>;
    }

    if(macro && macro.name === 'WriteFile') {
      fileOut = macro.component as Macro<string>;
    }
  });

  // we get the directory contents using the dirIn macro
  const dirContents: { name: string, extension?: string, size?: number}[] = JSON.parse(
    await dirIn([$path, 'true', '*', 'json', 'false'], state)
  );

  let question = `Write a review on file structure for the following directory: ${$path}
  \`\`\`txt
  ${dirContents.map(f => `${f.name}`).join('\n')}\n\n
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
  const message = updatedResponse.choices[0].message;

  const reviewFile = pathModule.join(__dirname, 'samples/review.md');
  //start the review
  await fileOut([reviewFile, message.content, 'overwrite'], state);

  // we iterate over the directory contents and perform a code review on each file
  let lastReviewTS = Date.now();

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const file of dirContents) {
    const doReview = async () => {
      if (file.size > 0) {
        if (file.size < 100000) {
          const filePath = pathModule.join($path, file.name);
          const fileResult = await CodeReviewFile([filePath, specs], state);

          await fileOut([reviewFile, fileResult, 'append'], state);
        } else {
          await fileOut([reviewFile, `File ${file.name} is too large to review - Skipping review\n`, 'false'], state);
        }
      } else {
        await fileOut([reviewFile, `No content found for file ${file.name} - Skipping review\n`, 'false'], state);
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

  const review = await fileIn([reviewFile], state);

  let finalPrompt = createPrompt(
    modelId,
    `Summarize and format the review generated ${$path}:\n${review}`,
    history,
    'system'
  );

  const result = await getAIResponse(ai, finalPrompt, state);

  // Clone the response to avoid mutating the original object
  const finalResponse = JSON.parse(JSON.stringify(result));

  // Access message object
  const finalMessage = finalResponse.choices[0].message;
  // we return the final message & overwite the review file with the updated review
  await fileOut([reviewFile, finalMessage.content], state);

  return finalMessage.content;
}

/**
 * Registry entry for the CodeReview macro
 */
export const CodeReviewComponentRegister: Reactory.IReactoryComponentDefinition<typeof CodeReview> = { 
  nameSpace: 'reactor',
  name: 'CodeReview',
  version: '1.0.0',
  component: CodeReview,
  description: readFileSync(require.resolve('./review.macro.md'), 'utf-8').toString(),
  features: [],
  stem: 'review',
  tags: ['code', 'review', 'development', 'file', 'directory'],
}


/**
 * Registry of development macros
 */
export const DevelopmentMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  CodeReviewComponentRegister,
  CodeReviewFileComponentRegister,
];