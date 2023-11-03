import { ChatCompletionResponseMessage, OpenAIApi } from "openai"
import { Interface as ReadLineInterface } from "readline";
import { Chat } from ".";

export type Macro<TResult> = (params: any[], state: ChatState) => Promise<TResult>

export type MacroFunctions = {
  [macro: string]: Macro<unknown>
};


export type KnownCannedMessages = 
  "welcome" | 
  "help" | 
  "goodbye" | 
  "error" |
  "givemeaccess"

export type CanedMessages = {
  [key in KnownCannedMessages]: string;
};

export type RatedChatCompletionResponseMessage = ChatCompletionResponseMessage & { rating?: number };

export type ChatMessage = ChatCompletionResponseMessage | RatedChatCompletionResponseMessage;

/**
 * Represents the state of a chat session.
 */
export type ChatState = {
  /**
   * The unique identifier for the chat session. This will be null
   * until the chat session is persisted to the database.
   */
  id?: string
  /**
   * The unique identifier for the bot that is being used for the chat session.
   * 
   * The id of the bot defines what configuration is used for the bot.
   * */
  botId: string
  /**
   * The date and time the chat session was started.
   */
  started: Date
  /**
   * The OpenAI API key used for the chat session.
   */
  apiKey: string
  /**
   * The OpenAI API organization used for the chat session.
   */
  apiOrg: string
  /**
   * The OpenAI API model used for the chat session.
   */
  modelId: string
  /**
   * The history of the chat session.
   */
  history: ChatMessage[]
  /**
   * The OpenAI API instance used for the chat session.
   */
  ai: OpenAIApi
  /**
   * The authentication token for the chat session, this is for authentication 
   * against the reactory server.
   */
  authToken?: string
  /**
   * The user that is associated with the chat session, this will be in the 
   * form of an API status object.
   */
  user?: Reactory.Models.IApiStatus
  /**
   * The context for the chat session.
   */
  context?: Reactory.Server.IReactoryContext
  /**
   * The date the chat session was persisted to the database.
   */
  created?: Date  
  /**
   * The date the chat session was last updated.
   */
  updated?: Date
  /**
   * 
   * The macros that are available for the chat session.
   * */
  macros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[]
  /**
   * The readline interface for the chat session.
   */
  rl?: ReadLineInterface
  /**
   * Variables that are available for the chat session.
   * */
  vars: {
    [key: string]: unknown
  }
}

export interface QuestionHandlerResponse {
  next: IQuestion | null,
  state: ChatState
}

export interface IQuestion {
  id?: number,
  when?: Date,
  question: string,
  response?: string,
  output?: unknown,
  valid?: boolean,
  handler: (response: string, state: ChatState) => Promise<QuestionHandlerResponse>
}

export interface IQuestionGroup {
  [key: string | symbol]: IQuestion,
}

export interface IQuestionCollection {
  [key: string | symbol]: IQuestionGroup
}