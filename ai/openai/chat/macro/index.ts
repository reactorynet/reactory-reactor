import { ChatState, Macro, MacroFunctions } from '@reactory/server-core/modules/reactor/types/chat.types';
import  { 
  ReadFile, 
  WriteFile,
  ExtractFile,
  ListDirectory,
  InsertSnippet,
  FileMacros,
} from './fs/file.ai.macro';
import { FetchMacro } from './web/http.ai.macro';
import { QueryGQL, MutationGQL } from './graphql/graphql.macro';
import { ServiceRegister } from './workflow/workflow.ai.macro';
import { CreateUser, GetUser } from './workflow/user.ai.macro';
import { CodeReview, CodeReviewFile, DevelopmentMacros } from './develop/develop.ai.macro';


import { CreateChatCompletionRequest, CreateCompletionResponse } from 'openai';

export const REACTOR_MACRO_MD = require.resolve('./macros.md');

export const MacroRegistry: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  ...FileMacros,
  ...DevelopmentMacros,

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

// Usage
const inputMacros: MacroFunctions = {
  file: ReadFile,
  ReadFile,
  ExtractFile,
  snip: ExtractFile,
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
  codeReview: CodeReview,
  codeReviewFile: CodeReviewFile,
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

  // Access message object
  const message = updatedResponse.choices[0].message;

  let match;
  const macros = message.role === 'system' || message.role === 'user' ? inputMacros : outputMacros;
  const input = prompt.messages[prompt.messages.length - 1];
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
