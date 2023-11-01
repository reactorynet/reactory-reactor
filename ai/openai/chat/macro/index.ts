import { ChatState, Macro, MacroFunctions } from 'modules/reactor/ai/openai/types/chat';
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


import { ChatCompletionResponseMessage, CreateChatCompletionRequest, CreateCompletionResponse } from 'openai';
import Hash from 'utils/hash';

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

export async function handleChatCompletionResponse(
  response: CreateCompletionResponse, 
  prompt: CreateChatCompletionRequest,
  state: ChatState
  ): Promise<CreateCompletionResponse> {

  const regex = /@(\w+)\((.*?)\)/g;

  // Clone the response to avoid mutating the original object
  const updatedResponse = JSON.parse(JSON.stringify(response));
  const message = updatedResponse.choices[0].message;

  let match;
  const macros = { ...inputMacros, ...outputMacros };
  
  const input = message.content;
  while ((match = regex.exec(input.content)) !== null) {
    const [macro, ...params] = match.slice(1);
    const splitParams = params[0].split(',');

    if (macros[macro]) {
      const replacement = await macros[macro]([...splitParams, message.content], state) as string;
      message.content = message.content.replace(`@${macro}(${params[0]})`, replacement);
    } else {
      console.warn(`No function found for macro @${macro}`);
    }
  }

  return updatedResponse;
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
        return `${result.macro}`;
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
    return `${results.map(result => generateContentFromResult(result, debug))}`
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
