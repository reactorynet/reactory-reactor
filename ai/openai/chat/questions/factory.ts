import * as fs from 'fs';
import { ReadLine } from "readline";
import { 
  ChatCompletionRequestMessage,
  ChatCompletionResponseMessage, 
  Configuration, 
  CreateChatCompletionRequest, 
  OpenAIApi 
} from "openai";
import { ChatState, IQuestion, RatedChatCompletionResponseMessage } from "../../types/chat";
import {
  handleUserResponse,
  handleChatCompletionResponse,
  MacroRegistry,
  handleCommandAction
} from '../macro';
import { colors } from '../../../../helpers';
import ReactorConversationModel from '@reactory/server-modules/reactor/models/ReactorChatState';

export const SYSTEM_INITIALIZER_MESSAGE: ChatCompletionResponseMessage = {
  role: 'system',
  content: fs.readFileSync(require.resolve('../macro/macros.md'), 'utf-8').toString(),
};


export const INITIAL_CHAT_STATE: ChatState = {
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
  vars: {},
}

export const extractResponse = (response: any, question: string) => {
  if (response && response?.choices) {
    return response.choices[0].message;
  } else {
    if (response && response.content) {
      return response.content;
    } else {
      return `AI system failed to respond to the following prompt: ${question}`;
    }
  }
}


export const persistChatState = async (state: ChatState): Promise<void> => {
  const { history, botId, modelId, started, context, id } = state;
  const { user } = context;
  const meta = {
    summary: 'Chat session with Reactor',
    title: `Chat session with Reactor`,
  };

  let chat = await ReactorConversationModel.findById(id);
  if (!chat) {
    chat = new ReactorConversationModel({
      _id: id,
      id,
      botId,
      modelId,
      started,
      history,
      user,
      meta,
    });
    await chat.save();
  } else {
    chat.history = history;
    chat.updated = new Date();
    await chat.save();
  }
}


export function createPrompt(modelId: string, message: string, history: any[], role?: string): CreateChatCompletionRequest {
  let messages = [
    ...history,
    {
      role: role || 'assistant',
      content: message,
    },
  ];

  return {
    model: modelId,
    messages: messages,
  };
}

export async function getAIResponse(ai: OpenAIApi, prompt: CreateChatCompletionRequest, state: ChatState): Promise<ChatCompletionResponseMessage> {
  try {
    const aiResponse = await ai.createChatCompletion(prompt);
    const parsed = await handleChatCompletionResponse(aiResponse.data, prompt, state);
    const { choices } = parsed;
    //@ts-ignore
    return choices[0].message;
  } catch (error) {
    console.error(`Error getting AI response: ${error}`);
    return {
      role: 'assistant',
      content: "I'm sorry, I couldn't process that. Could you please rephrase or try again later?"
    };
  }
}

// Prune the history to respect OpenAI API limits
const pruneHistory = (history: ChatCompletionResponseMessage[]): ChatCompletionResponseMessage[] => {
  const MAX_TOKENS = 4096;
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

  // check if the last message was a question
  // if it is, we clear the default question
  if (state.history.length > 1) {
    if(state.history[state.history.length - 1].content.includes("?")) {
      question = "";
    }
  }
  let prompt = createPrompt(modelId, question, state.history);

  return {
    question,
    handler: async (response, state) => {
      // Add the command's response to the messages
      const userInput: ChatCompletionRequestMessage = {
        role: 'user',
        content: response,
      };
      
      const getNextState = () => {
        // Add the old chat's history to the new chat's state
        const prunedHistory = pruneHistory(state.history);
        let nextState = { ...state }
        nextState.history = prunedHistory;        
        return nextState;
      }

      state.history.push(userInput);
      let nextState = getNextState();
      
      let message: ChatCompletionResponseMessage & { rating?: number }; // The AI's response or the system comamnd response
      if (response.indexOf('/') === 0) {
        // handle command message
        const commandResult = await handleCommandAction(response, nextState);
        // prompt.messages.push(userInput);
        message = commandResult
      } else {
        userInput.content = await handleUserResponse(response, state);
        // Add the user's response to the messages
        prompt.messages.push(userInput);
        // Get AI's response
        message = await getAIResponse(ai, prompt, nextState);        
      }

      nextState.history.push(message);
      // Display the AI's response
      const { botId = 'Reactor' } = state;
      rl.write(`${colors.yellow(`[${botId}]>`)}${ colors.green(`${message.content}`)}\n`);
      // we want to prompt the user to give a rating for the response

      const rateResponse = async (aiResponseMessage: ChatCompletionRequestMessage, state: ChatState): Promise<RatedChatCompletionResponseMessage> => { 
        
        return new Promise((resolve, reject) => { 
          const ratedMessage = { ...aiResponseMessage, rating: 0 };
          if (ratedMessage.content.length > 0) {        
            rl.question(`${colors.yellow(`[${botId}]>`)}${ colors.green(`How would you rate this response? (1-10)`)}\n`, (rating) => { 
              if (rating && rating.length > 0) {           
                try { 
                  ratedMessage.rating = parseInt(rating, 10);
                  resolve(ratedMessage);
                } catch (error) { 
                  reject(error);
                }                                 
              }
            })
          }
        });        
      }
      
      // if reactor is running in training mode, we want to prompt the user to give a rating for the response 
      if (process.env.OPENAI_TRAINING_MODE === 'true') { 
        try {
          const ratedMessage = await rateResponse(message, state);
          nextState.history[nextState.history.length - 1] = ratedMessage;
        } catch (error) { 
          let errorMessage = `Error rating response: ${error}\n`;
          console.error(errorMessage);
        }
      } 
      //persist the chat state to the database
      await persistChatState(nextState);

      return {
        next: ChatFactory(rl, nextState),
        state: nextState,
      }
    },
  };
};


