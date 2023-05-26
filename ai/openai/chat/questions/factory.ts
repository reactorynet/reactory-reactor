import * as fs from 'fs';
import { ReadLine } from "readline";
import { ChatCompletionResponseMessage, Configuration, CreateChatCompletionRequest, OpenAIApi } from "openai";
import { ChatState, IQuestion, IQuestionCollection, QuestionHandlerResponse } from "../../../../types/chat.types";
import { 
  handleUserResponse, 
  handleChatCompletionResponse,
  MacroRegistry,
  getMacro,
} from '../macro';
import { template } from 'lodash';

export const SYSTEM_INITIALIZER_MESSAGE: ChatCompletionResponseMessage = {
  role: 'user',
  content: fs.readFileSync(require.resolve('../macro/macros.md'), 'utf-8').toString(), 
};

const INITIAL_CHAT_STATE: ChatState = {
  modelId: process.env.OPENAI_MODEL_ID || '',
  started: new Date(),
  history: [
    SYSTEM_INITIALIZER_MESSAGE
  ],
  apiKey: process.env.OPENAI_API_KEY || '',
  apiOrg: process.env.OPENAI_ORG || '',
  ai: new OpenAIApi(new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_ORG,
  })),
  botId: 'Reactor',
  macros: MacroRegistry,
}

// Move this to a separate function
function createPrompt(modelId: string, message: string, history: any[]): CreateChatCompletionRequest {
  let messages = [
    ...history,
    {
      role: 'assistant',
      content: message,
    },
  ];

  return {
    model: modelId,
    messages: messages,
  };
}

// Move this to a separate function
async function getAIResponse(ai: OpenAIApi, prompt: CreateChatCompletionRequest, state: ChatState): Promise<ChatCompletionResponseMessage> {
  try {
    const aiResponse = await ai.createChatCompletion(prompt);
    const parsed = await handleChatCompletionResponse(aiResponse.data, prompt, state);
    const { choices } = parsed;
    //@ts-ignore
    return choices[0].message;
  } catch (error) {
    console.error(`Error getting AI response: ${error}`);
    return  { 
      role: 'assistant',
      content:  "I'm sorry, I couldn't process that. Could you please rephrase or try again later?"
    };
  }
}

// Prune the history to respect OpenAI API limits
function pruneHistory(history: any[]): any[] {
  const MAX_TOKENS = 4096;  // You may need to adjust this according to OpenAI's limits
  let totalTokens = 0;

  // Reverse history so that we start counting from the most recent messages
  const reversedHistory = [...history].reverse();

  const prunedHistory = reversedHistory.filter((message) => {
    totalTokens += message.content.split(' ').length; // Approximate token count
    return totalTokens <= MAX_TOKENS;
  });

  // Return it to the original order
  return prunedHistory.reverse();
}

const handleCommandAction = async (response: string, state: ChatState): Promise<any> => { 
  const [command, ...params] = response.split(' ');
  const macro = getMacro(command);
  if(macro) {
    return await macro(params, state);
  }
  return 'Command not found';
}

export const ChatFactory = (rl: ReadLine, state: ChatState = INITIAL_CHAT_STATE): IQuestion => {

  const {
    modelId,
    started,
    ai,
    context
  } = state;

  const { user } = context;

  let question = state.history.length === 1 ?
    `Hi ${user?.firstName ? user.firstName : 'Anon'}, how can we build better applications today with reactory?` : 'What else can I help you with?'; 

  // Prune history before passing to createPrompt
  // let history = pruneHistory(state.history);

  let prompt = createPrompt(modelId, question, state.history);

  return {
    question,
    handler: async (response, state) => {
      if(response.indexOf('/') === 0) {
        // handle command message
        await handleCommandAction(response, state);
      }
      const processedResponse = await handleUserResponse(response, state);
      const userResponse: ChatCompletionResponseMessage = {
        role: 'user',
        content: processedResponse,
      };
      // Add the user's response to the messages
      prompt.messages.push(userResponse);
      
      // Add the old chat's history to the new chat's state
      const prunedHistory = pruneHistory(state.history);
      const nextState = { ...state }
      nextState.history = prunedHistory;
      state.history.push(userResponse);

      // Get AI's response
      const message = await getAIResponse(ai, prompt, state);

      // Add the AI's response to the chat history
      nextState.history.push(message);

      rl.write(`
    Reactor: ${message.content}
  `);

      return {
        next: ChatFactory(rl, nextState),
        state: nextState,
      }
    },
  };
};
