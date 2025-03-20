import { ChatState, Macro, MacroComponentDefinition, MacroFunctions } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import FileMacros from './fs';
import DevelopmentMacros from './develop';
import EmailMacros from './email';
import FastAIMacros from './fastai';
import GraphqlMacros from './graphql';
import RuntimeMacros from './runtime';
import ShellMacros from './shell';
import UserMacros from './user';
import WebMacros from './web';
import WorkflowMacros from './workflow';
import ChatsMacros from './chats';

import  { 
  ReadFile, 
  WriteFile,
  ExtractTextFromFile,
  ListDirectory,
  InsertSnippet,
} from './fs/macro';
import { FetchMacro } from './web/macro';
import { QueryGQL, MutationGQL } from './graphql/macro';
import { ServiceRegister } from './workflow/macro';
import { CreateUser, GetUser } from './user/macro';


import { 
  review,
  reviewFile,
} from './develop';


import OpenAI from 'openai';
import Hash from '@reactory/server-core/utils/hash';
import __index from 'modules/__index';

export const REACTOR_MACRO_MD = require.resolve('./macros.md');

// Usage
const inputMacros: MacroFunctions = {
  file: ReadFile,
  ReadFile,
  ExtractFile: ExtractTextFromFile,
  snip: ExtractTextFromFile,
  ListDirectory,
  read: ReadFile,
  readFile: ReadFile,
  ls: ListDirectory,
  listDirectory: ListDirectory,
  fetch: FetchMacro,
  http: FetchMacro,
  gql: QueryGQL,
  ServiceRegister,
  svc: ServiceRegister,
  user: GetUser,
  getUser: GetUser,
  GetUser,
  review,
  reviewFile,
};

const outputMacros: MacroFunctions = {
  out: WriteFile,
  outFile: WriteFile,
  WriteFile,
  gml: MutationGQL,
  CreateUser,
  createUser: CreateUser,
  replace: InsertSnippet,
  insert: InsertSnippet,
};


export const MacroRegistry: MacroComponentDefinition<unknown>[] = [
  ...FileMacros,
  ...DevelopmentMacros,
  ...EmailMacros,
  ...FastAIMacros,
  ...GraphqlMacros,
  ...RuntimeMacros,
  ...ShellMacros,
  ...UserMacros,
  ...WebMacros,
  ...WorkflowMacros,
  ...ChatsMacros
];

export const getMacrosMD = (): string => {
  const macrosText = MacroRegistry.map((macro) => {
    return `### ${macro.name}\n${macro.description}\n\n`;
  }).join('');

  return REACTOR_MACRO_MD.replace('{{macros}}', macrosText);
}

export const getMacro = <T>(name: string): Macro<T> | undefined => { 
  return MacroRegistry.find((macro) => macro.name === name)?.component as unknown as Macro<T>;
}

export type MacroExecutionResult<T> = {
  id: number;
  macro: string,
  error?: string;
  value?: T;
  state: ChatState
}

export interface MacroInstructionSetResult {
  id: number,  
  hasErrors: boolean,
  results: MacroExecutionResult<unknown>[],
  state: ChatState;
}

/**
 * Execuertes
 */
export async function executeMacro<T>(macro: string, state: ChatState): Promise<MacroExecutionResult<T>> {
  if(!macro) throw new Error(`Macro expression null or undefined`);
  if(!state) throw new Error(`Chatstate is null or undefind`);
  const id = Hash(macro);
  const regex = /@(\w+)\((.*?)\)/g;
  const match = regex.exec(macro);
  let nextState: ChatState = { ...state };
  let value: T = null;
  let error: string = null;
  try {    
    const [_macro, ...params] = match.slice(1);
    const splitParams = params[0].split(',');
    const macroToExecute = getMacro<T>(_macro);
    if (macroToExecute && typeof macroToExecute === "function") {
      value = await macroToExecute([...splitParams], nextState) as T;      
    } else {
      error = `Macro ${_macro} not found`;
    }
  } catch (macroError) {
    error = macroError?.message || `Unknown error executing macro: ${macro}}`;
  }

  return { 
    id,
    error,
    value,
    macro,
    state: nextState
  };
}

/**
 * This function will execute an instruction set of macros in a 0 to n
 * @param macros 
 * @param state 
 * @returns 
 */
export async function processMacroInstructionSet(macros: string[], state: ChatState): Promise<MacroInstructionSetResult> {
  if (state === null || state === undefined) throw new Error('Requires state variable');
  let nextState: ChatState = { ...state };
  let hasErrors: boolean = false;
  let results: MacroExecutionResult<unknown>[] = [];
  let ids = '';
  if (macros && macros.length > 0) {
    for (const macro of macros) {
      try {
        const result = await executeMacro(macro, nextState);
        ids += macro;
        if (result.error) {
          hasErrors = true;
        }

        if (results) {
          results.push(result);
        }
      } catch (err) {
        results.push({ id: Hash(macro), state: nextState, macro, error: err.message || 'Unknown error', value: undefined });
      }
    }
  }

  return {
    id: Hash(ids),
    hasErrors,
    results,
    state: nextState,
  };
}

/**
 * This function will parse a macro file / string create a set of instructions 
 * and execute them
 * @param macro 
 * @param state 
 * @returns 
 */
export function parse(input: string, state: ChatState): string[] {
  const instructionSet: string[] = [];

  const regex = /@(\w+)\((.*?)\)/g;  
  let match;  
  while ((match = regex.exec(input)) !== null) {
    const [macro, ...params] = match.slice(1);
    instructionSet.push(`@${macro}(${params[0]})`);
  }

  return instructionSet;
}


export async function handleUserResponse(userResponse: string, state: ChatState): Promise<string> {
  // If userResponse is empty, return it as is
  if (!userResponse || userResponse.trim() === '') {
    return userResponse;
  }
  
  // Extract all macros and their parameters from the user response
  const regex = /@(\w+)\((.*?)\)/g;
  let match;
  let result = userResponse;
  
  // Collect all matches first
  const matches = [];
  let tempUserResponse = userResponse;
  while ((match = regex.exec(tempUserResponse)) !== null) {
    matches.push({
      fullMatch: match[0],
      macro: match[1],
      params: match[2]
    });
  }
  
  // Process matches in reverse order to avoid offset issues
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, macro, params } = matches[i];
    const splitParams = params.split(',');
    
    // Check if there is a function for this macro
    if (inputMacros[macro]) {
      try {
        // Replace the macro with the result of its function
        const replacement: string = await inputMacros[macro](splitParams, state) as string;
        result = result.replace(fullMatch, replacement);
      } catch (error) {
        console.error(`Error executing macro ${macro}:`, error);
      }
    } else {
      // console.warn(`No function found for macro @${macro}`);
    }
  }

  return result;
}


/**
 * 
 */
export async function makeSelectionFromChoices(choices: OpenAI.ChatCompletionChoice[], state: ChatState): Promise<number> {
  const { rl } = state;
  let choice_index = 0;  
  choices.forEach((choice) => {
    choice_index++;            
    const text = choice.message?.content || '';
    const lines = text.split('\n');      
    rl.write(`${choice_index}. ${lines[0]}\n`);      
  });

  rl.write(`Please select one of the results by typing the number of the result you want to see\n`);
  return new Promise((resolve, reject) => { 
    rl.question(``, (answer) => { 
      try { 
        choice_index = parseInt(answer);
        resolve(choice_index);
      } catch (e) {
        reject(e);
      }
    })
  })

}

/**
 * This function will handle the completion response from the openai api
 * @param response 
 * @param prompt 
 * @param state 
 * @returns 
 */
export async function handleChatCompletionResponse(
  response: OpenAI.ChatCompletion, 
  prompt: OpenAI.ChatCompletionCreateParams,
  state: ChatState
  ): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice & { __index: number }> {

  // Clone the response to avoid mutating the original object
  const cloned: OpenAI.ChatCompletion = JSON.parse(JSON.stringify(response));
  // first we check if there is a macro block definition
  // which is recognise by the characters ```rfm as the start of the block and ``` as the end of the block
  // const macroBlockRegex = /```rfm([\s\S]*?)```/g;
  let choice_index = 0;  
  // if there is more than one choice we need display a short summary of each choice
  // and then ask the user to select one of the choices to display the full text  
  if(cloned.choices.length > 1) { 
    let validChoice = false;
    while(!validChoice) { 
      choice_index = await makeSelectionFromChoices(cloned.choices, state);
      if(choice_index > 0 && choice_index <= cloned.choices.length) { 
        validChoice = true;
      } else {
        state.rl.write(`Invalid choice, please select a number between 1 and ${cloned.choices.length}\n`);
      }
    }    
  }


  // let macroBlockMatch = macroBlockRegex.exec(cloned.choices[choice_index].message?.content || '');
  // //if we have matches in our regex, we need to execute the macros
  // //the AI is giving us a request to execute macros and we need to give the user
  // //the option to execute them or not as a safeguard against macros that
  // //may be harmful to the system
  
  // // macro regex is used to identify a macro snippet
  // const macroRegex = /@(\w+)\((.*?)\)/g;
  
  // if (macroBlockMatch?.length > 0) { 
  //   // check each matched block for macros
  //   // we need to execute the the loop for each block in 
  //   // an async manner so we can prompt the user for each block
  //   // if they want to execute the macros in the block
  //   for (let i = 0; i < macroBlockMatch.length; i++) {
  //     const block = macroBlockMatch[i];
  //     const blockIdRegex = /```rfm #(\w+)/g;
  //     const blockIdMatch = blockIdRegex.exec(block);
  //     let blockId = i.toString();
  //     if(blockIdMatch.length > 0) { 
  //       blockId = blockIdMatch[1];
  //     }

  //     // we need to generate a message to prompt the user if they want to execute the macros
  //     // in the code block. We will use the block id as the message 
  //     // and the user will have to type (y)es or (n)o to execute the macros
  //     // or not
  //     state.rl.write(`\n${blockId}\n`);
  //     state.rl.write(`${block}\n`);
  //     state.rl.write(`\nExecute macros in this block? (y)es or (n)o\n`);
  //     const answer: string = await new Promise((resolve, reject) => { 
  //       state.rl.question(``, (answer) => { 
  //         resolve(answer);
  //       })
  //     })

  //     if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') { 
  //       let match;
  //       const macros = { ...inputMacros, ...outputMacros };
        
  //       const input = block;
  //       while ((match = macroRegex.exec(input)) !== null) {
  //         const [macro, ...params] = match.slice(1);
  //         const splitParams = params[0].split(',');

  //         if (macros[macro]) {
  //           const replacement = await macros[macro]([...splitParams, block], state) as string;
  //           cloned.choices[choice_index].text = block.replace(`@${macro}(${params[0]})`, replacement);
  //         } else {
  //           console.warn(`No function found for macro @${macro}`);
  //         }
  //       }
  //     }
  //   }
  // }

  // const message = cloned.choices[choice_index].message.content;
  // let match;
  // const macros = { ...inputMacros, ...outputMacros };
  
  // const input = message;
  // while ((match = macroRegex.exec(input)) !== null) {
  //   const [macro, ...params] = match.slice(1);
  //   const splitParams = params[0].split(',');

  //   if (macros[macro]) {
  //     const replacement = await macros[macro]([...splitParams, message], state) as string;
  //     if (cloned.choices[choice_index].message) {
  //       cloned.choices[choice_index].message.content = message.replace(`@${macro}(${params[0]})`, replacement);
  //     }
  //   } else {
  //     console.warn(`No function found for macro @${macro}`);
  //   }
  // }

  return { 
    ...cloned.choices[choice_index],
    __index: choice_index
  };
}

function generateContentFromResult(result: MacroExecutionResult<unknown>, debug: boolean = false): string {
  const resultType = typeof result.value;
  if(debug === true) return `
  macro: ${result.macro}
  value: ${result.value}
  type: ${resultType}
  `
  else {
    let _type = typeof result.value;
    switch(_type) {
      case 'object': {
        if (result?.value?.toString && 
          typeof result.value.toString === 'function') return result.value.toString();
        else return `
        \`\`\`json
        ${JSON.stringify(result.value, null, 2)}
        \`\`\`
        `
      }
      default: {
        return `${result.value}`;
      }
    }
  }
}

function generateContentFromResults(instructionSetResult: MacroInstructionSetResult, debug: boolean = false): string {
  const {
    id,
    hasErrors,
    results,
  } = instructionSetResult;

  if(debug === true) {
    return `
    id: ${id},
    generated errors: ${hasErrors ? 'yes' : 'no'},
    errors: ${results.map(result => `${result.error ? result.macro + ' -> ' + result.error + '\n' : ''}`)}    
    ${results.map( result => generateContentFromResult(result, debug))}
  `
  } else {
    const content = `${results.map(result => generateContentFromResult(result, debug))}`
    return content;
  }
  
}

/**
 * Responsible for creating and executing a set of command actions from a user input.
 * Processes a sequence of macros in the order they appear in the input.
 * @param response - The user input containing macro commands
 * @param state - The current chat state
 * @returns OpenAI.ChatCompletionMessageParam - The formatted results as an assistant message
 */
export const handleCommandAction = async (response: string, state: ChatState): Promise<OpenAI.ChatCompletionMessageParam> => {
  const instructionSet: string[] = [];
  const regex = /@(\w+)\((.*?)\)/g;  
  let match;
  
  // Extract all macro commands from the input
  while ((match = regex.exec(response)) !== null) {
    // Use direct access to match groups to preserve the original parameter string with all commas
    const macroName = match[1];
    const paramString = match[2];
    instructionSet.push(`@${macroName}(${paramString})`);
  }
  
  if (instructionSet.length === 0) {
    return {
      role: 'assistant',
      content: 'No commands found. Please use the @macro(params) syntax to execute commands.',      
    };
  }

  // Process all macros in sequence
  const result = await processMacroInstructionSet(instructionSet, state);
  
  // Format the results with sequence information
  let content = '';
  
  if (result.hasErrors) {
    content += `⚠️ Some commands encountered errors during execution.\n\n`;
  }

  // Display results in sequence with proper formatting
  content += result.results.map((macroResult, index) => {
    const stepNumber = index + 1;
    const statusIcon = macroResult.error ? '❌' : '✅';
    
    let stepOutput = `**Step ${stepNumber}**: ${statusIcon} \`${macroResult.macro}\`\n\n`;
    
    if (macroResult.error) {
      stepOutput += `Error: ${macroResult.error}\n\n`;
    } else {
      // Format the result value based on type
      const formattedValue = generateContentFromResult(macroResult, false);
      stepOutput += `${formattedValue}\n\n`;
    }
    
    return stepOutput;
  }).join('---\n\n');

  return {
    role: 'assistant',
    content: content.trim(),
  };
}
