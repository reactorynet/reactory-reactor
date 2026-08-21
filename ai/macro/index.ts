import { ChatState, Macro, MacroComponentDefinition, MacroFunctions } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import FileMacros from './fs';
import DevelopmentMacros from './develop';
import GraphqlMacros from './graphql';
import RuntimeMacros from './runtime';
import ShellMacros from './shell';
import UserMacros from './user';
import WebMacros from './web';
import WorkflowMacros from './workflow';
import ChatsMacros from './chats';
import MCPMacros from './mcp';
import ProjectMacros from './projects';
import GraphMacros from './graph';
import DataMacros from './data';
import ModuleMacros from './develop/module';
import PlaywrightMacros from './playwright';
import SkillsMacros from './skills';
import ImageMacros from './image';
import SupportMacros, {
  GetSupportTicket,
  ListSupportTickets,
  CreateSupportTicket,
  UpdateSupportTicket,
  AddSupportTicketComment,
} from './support';

export { MacroErrorCode, MacroError, createMacroError } from './errors';
export { summarizeItems, truncateOutput } from './summarize';
export { signMacroRequest, verifyMacroRequest } from './signing';
import  { 
  ReadFile, 
  ReadChatFile,
  WriteFile,
  ExtractTextFromFile,
  ListDirectory,
  //InsertSnippet,
} from './fs/macro';
import { FetchMacro } from './web/macro';
import { QueryGQL, MutationGQL } from './graphql/macro';
import { ServiceRegister } from './workflow/macro';
import { CreateUser, GetUser } from './user/macro';

import { 
  CodeReview,
  CodeReviewFile,
} from './develop/review/macro';

import { PlaywrightNavigate, PlaywrightOpenSession } from './playwright/macro';
import { AddToolsToSessionMacro, RemoveToolsFromSessionMacro } from './runtime/sessionTools.macro';

import OpenAI from 'openai';
import Hash from '@reactory/server-core/utils/hash';

import ReactoryModules from '@reactory/server-core/modules';

export const REACTOR_MACRO_MD = require.resolve('./macros.md');

// Usage
const inputMacros: MacroFunctions = {
  file: ReadFile,
  ReadFile,
  ReadChatFile,
  readChatFile: ReadChatFile,
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
  review: CodeReview,
  reviewFile: CodeReviewFile,
  getSupportTicket: GetSupportTicket,
  GetSupportTicket,
  listSupportTickets: ListSupportTickets,
  ListSupportTickets,
  playwright: PlaywrightNavigate,
  pw: PlaywrightNavigate,
  playwright_open: PlaywrightOpenSession,
  addToolsToSession: AddToolsToSessionMacro,
  removeToolsFromSession: RemoveToolsFromSessionMacro,
};

const outputMacros: MacroFunctions = {
  out: WriteFile,
  outFile: WriteFile,
  WriteFile,
  gml: MutationGQL,
  CreateUser,
  createUser: CreateUser,
  createSupportTicket: CreateSupportTicket,
  CreateSupportTicket,
  updateSupportTicket: UpdateSupportTicket,
  UpdateSupportTicket,
  addSupportTicketComment: AddSupportTicketComment,
  AddSupportTicketComment,
  // replace: InsertSnippet,
  // insert: InsertSnippet,
};


export const MacroRegistry: MacroComponentDefinition<unknown>[] = [
  ...FileMacros,
  ...DevelopmentMacros,
  // EmailMacros and FastAIMacros are excluded - stub implementations with no functionality.
  // Re-add when email/fastai macros are implemented.
  ...GraphqlMacros,
  ...RuntimeMacros,
  ...ShellMacros,
  ...UserMacros,
  ...WebMacros,
  ...WorkflowMacros,
  ...ChatsMacros,
  ...MCPMacros,
  ...ProjectMacros,
  ...GraphMacros,
  ...DataMacros,
  ...ModuleMacros,
  ...PlaywrightMacros,
  ...SkillsMacros,
  ...SupportMacros,
];

export const getMacrosMD = (): string => {
  const macrosText = MacroRegistry.map((macro) => {
    return `### ${macro.name}\n${macro.description}\n\n`;
  }).join('');

  return REACTOR_MACRO_MD.replace('{{macros}}', macrosText);
}

export const getMacro = <T>(name: string): Macro<T> | undefined => { 
  return MacroRegistry.find((macro) => macro.name === name)?.component as Macro<T>;
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
 * Executes a macro with proper parameter handling for both old and new macro signatures
 */
export async function executeMacro<T>(macro: string, state: ChatState): Promise<MacroExecutionResult<T>> {
  if(!macro) throw new Error(`Macro expression null or undefined`);
  if(!state) throw new Error(`Chatstate is null or undefined`);
  const id = Hash(macro);
  const regex = /@(\w+)\((.*?)\)/g;
  const match = regex.exec(macro);
  let nextState: ChatState = { ...state };
  let value: T = null;
  let error: string = null;
  
  try {    
    const [_macro, ...params] = match.slice(1);
    const splitParams = params[0] ? params[0].split(',').map(p => p.trim()) : [];
    
    // Find the macro component definition to understand its parameter structure
    const macroDefinition = MacroRegistry.find(m => m.name === _macro || m.alias === _macro);
    const macroToExecute = getMacro<T>(_macro);
    
    if (macroToExecute && typeof macroToExecute === "function") {
      if (macroDefinition?.tools?.[0]?.function?.parameters?.properties) {
        // New macro signature - convert array params to object
        const parameterProperties = macroDefinition.tools[0].function.parameters.properties;
        const parameterNames = Object.keys(parameterProperties);
        
        // Map array parameters to object properties based on the tool definition
        const props: any = {};
        
        // Handle different parameter mapping strategies
        if (parameterNames.length === 1 && parameterNames[0] === 'args') {
          // Legacy array-based parameter structure
          props.args = splitParams;
        } else {
          // New named parameter structure - map positional args to named props
          parameterNames.forEach((paramName, index) => {
            if (index < splitParams.length) {
              props[paramName] = splitParams[index];
            }
          });
        }
        
        value = await macroToExecute(props, nextState) as T;
      } else {
        // Fallback to old signature for macros that haven't been refactored yet
        value = await macroToExecute(splitParams, nextState) as T;
      }
    } else {
      error = `Macro ${_macro} not found`;
    }
  } catch (macroError) {
    error = macroError?.message ?? `Unknown error executing macro: ${macro}`;
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
        results.push({ id: Hash(macro), state: nextState, macro, error: err.message ?? 'Unknown error', value: undefined });
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
    const splitParams = params.split(',').map(p => p.trim());
    
    // Check if there is a function for this macro
    if (inputMacros[macro]) {
      try {
        // Find the macro definition to understand parameter structure
        const macroDefinition = MacroRegistry.find(m => m.name === macro || m.alias === macro);
        let macroArgs = splitParams;
        
        if (macroDefinition?.tools?.[0]?.function?.parameters?.properties) {
          // New macro signature - convert array params to object
          const parameterProperties = macroDefinition.tools[0].function.parameters.properties;
          const parameterNames = Object.keys(parameterProperties);
          
          if (parameterNames.length > 0 && parameterNames[0] !== 'args') {
            // New named parameter structure - create props object
            const props: any = {};
            parameterNames.forEach((paramName, index) => {
              if (index < splitParams.length) {
                props[paramName] = splitParams[index];
              }
            });
            macroArgs = props;
          }
        }
        
        // Replace the macro with the result of its function
        const replacement: string = await inputMacros[macro](macroArgs, state) as string;
        result = result.replace(fullMatch, replacement);
      } catch (error) {
        console.error(`Error executing macro ${macro}:`, error);
      }
    }
  }

  return result;
}


/**
 * 
 */
export async function makeSelectionFromChoices(choices: OpenAI.Chat.Completions.ChatCompletion.Choice[], state: ChatState): Promise<number> {
  const { rl } = state;
  let choice_index = 0;  
  choices.forEach((choice) => {
    choice_index++;            
    const text = choice.message?.content ?? '';
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
        reject(new Error(e instanceof Error ? e.message : String(e)));
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

  return { 
    ...cloned.choices[choice_index],
    __index: choice_index
  };
}

function generateContentFromResult(result: MacroExecutionResult<unknown>, debug: boolean = false): string {
  const resultType = typeof result.value;
  if(debug === true) {
    const valueStr = JSON.stringify(result.value);
    return `
  macro: ${result.macro}
  value: ${valueStr}
  type: ${resultType}
  `;
  } else {
    const _type = typeof result.value;
    if (_type === 'object' && result.value !== null) {
      const jsonStr = JSON.stringify(result.value, null, 2);
      return `
      \`\`\`json
      ${jsonStr}
      \`\`\`
      `;
    } else if (_type === 'string') {
      return result.value as string;
    } else if (_type === 'number') {
      return (result.value as number).toString();
    } else if (_type === 'boolean') {
      return (result.value as boolean).toString();
    } else {
      return JSON.stringify(result.value);
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
