import { ChatState, Macro, MacroFunctions } from 'modules/reactory-reactor/ai/openai/types/chat';
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


import { ChatCompletionResponseMessage, CreateChatCompletionRequest, CreateCompletionResponse, CreateCompletionResponseChoicesInner } from 'openai';
import Hash from '@reactory/server-core/utils/hash';

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


export const MacroRegistry: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
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
  // Extract macros and their parameters from the user response
  const regex = /@(\w+)\((.*?)\)/g;
  let match;
  let result = userResponse;

  while ((match = regex.exec(userResponse)) !== null) {
    const [macro, ...params] = match.slice(1);

    // Split the parameters by comma
    const splitParams = params[0].split(',');

    // Check if there is a function for this macro
    if (inputMacros[macro]) {
      // Replace the macro with the result of its function
      const replacement: string = await inputMacros[macro](splitParams, state) as string;
      result = result.replace(`@${macro}(${params[0]})`, replacement);      
    } else {
      // console.warn(`No function found for macro @${macro}`);
    }
  }

  return result;
}


/**
 * 
 */
export async function makeSelectionFromChoices(choices: CreateCompletionResponseChoicesInner[], state: ChatState): Promise<number> {
  const { rl } = state;
  let choice_index = 0;  
  choices.forEach((choice) => {
    choice_index++;            
    const text = choice.text;
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
  response: CreateCompletionResponse, 
  prompt: CreateChatCompletionRequest,
  state: ChatState
  ): Promise<CreateCompletionResponse> {

  // Clone the response to avoid mutating the original object
  const cloned: CreateCompletionResponse = JSON.parse(JSON.stringify(response));
  // first we check if there is a macro block definition
  // which is recognise by the characters ```rfm as the start of the block and ``` as the end of the block
  const macroBlockRegex = /```rfm([\s\S]*?)```/g;
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


  let macroBlockMatch = macroBlockRegex.exec(cloned.choices[choice_index].text);
  //if we have matches in our regex, we need to execute the macros
  //the AI is giving us a request to execute macros and we need to give the user
  //the option to execute them or not as a safeguard against macros that
  //may be harmful to the system
  
  // macro regex is used to identify a macro snippet
  const macroRegex = /@(\w+)\((.*?)\)/g;
  
  if (macroBlockMatch?.length > 0) { 
    // check each matched block for macros
    // we need to execute the the loop for each block in 
    // an async manner so we can prompt the user for each block
    // if they want to execute the macros in the block
    for (let i = 0; i < macroBlockMatch.length; i++) {
      const block = macroBlockMatch[i];
      const blockIdRegex = /```rfm #(\w+)/g;
      const blockIdMatch = blockIdRegex.exec(block);
      let blockId = i.toString();
      if(blockIdMatch.length > 0) { 
        blockId = blockIdMatch[1];
      }

      // we need to generate a message to prompt the user if they want to execute the macros
      // in the code block. We will use the block id as the message 
      // and the user will have to type (y)es or (n)o to execute the macros
      // or not
      state.rl.write(`\n${blockId}\n`);
      state.rl.write(`${block}\n`);
      state.rl.write(`\nExecute macros in this block? (y)es or (n)o\n`);
      const answer: string = await new Promise((resolve, reject) => { 
        state.rl.question(``, (answer) => { 
          resolve(answer);
        })
      })

      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') { 

      }
    }
  }

  const message = cloned.choices[choice_index].text;

  let match;
  const macros = { ...inputMacros, ...outputMacros };
  
  const input = message;
  while ((match = macroRegex.exec(input)) !== null) {
    const [macro, ...params] = match.slice(1);
    const splitParams = params[0].split(',');

    if (macros[macro]) {
      const replacement = await macros[macro]([...splitParams, message], state) as string;
      cloned.choices[choice_index].text = message.replace(`@${macro}(${params[0]})`, replacement);
    } else {
      console.warn(`No function found for macro @${macro}`);
    }
  }

  return cloned;
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
 * Responsible for create a set of command actions from a user input.
 * @param response 
 * @param state 
 * @returns 
 */
export const handleCommandAction = async (response: string, state: ChatState): Promise<ChatCompletionResponseMessage> => {

  const instructionSet: string[] = [];

  const regex = /@(\w+)\((.*?)\)/g;  
  let match;
  const input = response;
  while ((match = regex.exec(input)) !== null) {
    const [macro, ...params] = match.slice(1);
    instructionSet.push(`@${macro}(${params[0]})`);
  }
  
  if(instructionSet.length === 0) {
    return {
      role: 'system',
      content: 'No commands found, be sure to use the @ directive',
    }
  }

  const result = await processMacroInstructionSet(instructionSet, state);

  return {
    role: 'system',
    content: generateContentFromResults(result),
  }
}
