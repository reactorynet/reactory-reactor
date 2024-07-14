import * as fs from 'fs';
import { Interface, ReadLine } from "readline";
import { 
  ChatCompletionRequestMessage,
  ChatCompletionResponseMessage, 
  Configuration, 
  CreateChatCompletionRequest, 
  OpenAIApi 
} from "openai";
import { ChatState, IQuestion, RatedChatCompletionResponseMessage } from "modules/reactory-reactor/ai/openai/types/chat";
import {
  handleUserResponse,
  handleChatCompletionResponse,
  MacroRegistry,
  handleCommandAction
} from '../macro';
import { colors } from '../../../../helpers';
import ReactorConversationModel from 'modules/reactory-reactor/models/ReactorChatState';
import AIPersonaProvider from 'modules/reactory-reactor/services/PersonaService';
import { template } from 'lodash';
import { RecordNotFoundError } from '@reactory/server-core/exceptions';

export const SYSTEM_INITIALIZER_MESSAGE: ChatCompletionResponseMessage = {
  role: 'system',
  content: fs.readFileSync(require.resolve('../macro/macros.md'), 'utf-8').toString(),
};

export const getInitializerMessage = async (botId: string, state: ChatState, context: Reactory.Server.IReactoryContext) => {
  const personaService = context.getService<AIPersonaProvider>('reactor.AIPersonaProvider@1.0.0') as AIPersonaProvider;
  const persona = await personaService.getPersona(botId);
  const macros = state.macros.map(macro => `## ${macro.name}\n ## Usage\n${macro.description}`).join('\n');

  if(persona) {
    context.info(`Found persona for botId: ${botId}`);
    return {
      role: SYSTEM_INITIALIZER_MESSAGE.role,
      content: template(SYSTEM_INITIALIZER_MESSAGE.content)({ 
        macros, 
        persona 
      })
    }
  } else {
    context.warn(`No persona found for botId: ${botId}`);
    return  {
      role: SYSTEM_INITIALIZER_MESSAGE.role,
      content: template(SYSTEM_INITIALIZER_MESSAGE.content)({ macros, persona: { 
          persona: "You are Reactor default AI bot. You are neutral and have no personality. Your job is to answer questions.",
          features: "You have the following features: answering questions in general",
        }
      })
    }
  }
}


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
  persona: null,
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

export const askQuestion = async (chatSessionId: string, question: string, context: Reactory.Server.IReactoryContext): Promise<ChatState> => {
  //load session from database
  const conversationModel = await ReactorConversationModel.findById(chatSessionId).exec();

  if(conversationModel === null) throw new RecordNotFoundError(`Chat session with id ${chatSessionId} not found`);
  
  const chatState: ChatState = {
    ai: new OpenAIApi(new Configuration({ 
      apiKey: process.env.OPENAI_API_KEY,
      organization: process.env.OPENAI_ORG,
    })),
    apiKey: process.env.OPENAI_API_KEY || '',
    apiOrg: process.env.OPENAI_ORG || '',
    botId: conversationModel.botId,
    history: conversationModel.history,
    id: conversationModel.id,
    macros: MacroRegistry,
    modelId: conversationModel.modelId,
    persona: await context.getService<AIPersonaProvider>('reactor.AIPersonaProvider@1.0.0')?.getPersona(conversationModel.botId),
    started: conversationModel.started,
    vars: conversationModel.vars,
    context,
    authToken: "",
    created: conversationModel.created,
    updated: conversationModel.updated,
  };

  const fakeReadline: ReadLine = {
    write: (message: string) => {
      console.log(message);
    },
    question: (question: string, callback: (answer: string) => void) => {
      callback(question);
    },
    terminal: false,
    line: '',
    cursor: 0,
    setPrompt: function (prompt: string): void {
      throw new Error('Function not implemented.');
    },
    prompt: function (preserveCursor?: boolean): void {
      throw new Error('Function not implemented.');
    },
    pause: function (): Interface {
      throw new Error('Function not implemented.');
    },
    resume: function (): Interface {
      throw new Error('Function not implemented.');
    },
    close: function (): void {
      throw new Error('Function not implemented.');
    },
    addListener: function (event: string, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    emit: function (event: string | symbol, ...args: any[]): boolean {
      throw new Error('Function not implemented.');
    },
    on: function (event: string, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    once: function (event: string, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    prependListener: function (event: string, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    prependOnceListener: function (event: string, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    removeListener: function (event: string | symbol, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    off: function (event: string | symbol, listener: (...args: any[]) => void): Interface {
      throw new Error('Function not implemented.');
    },
    removeAllListeners: function (event?: string | symbol): Interface {
      throw new Error('Function not implemented.');
    },
    setMaxListeners: function (n: number): Interface {
      throw new Error('Function not implemented.');
    },
    getMaxListeners: function (): number {
      throw new Error('Function not implemented.');
    },
    listeners: function (event: string | symbol): Function[] {
      throw new Error('Function not implemented.');
    },
    rawListeners: function (event: string | symbol): Function[] {
      throw new Error('Function not implemented.');
    },
    listenerCount: function (type: string | symbol): number {
      throw new Error('Function not implemented.');
    },
    eventNames: function (): (string | symbol)[] {
      throw new Error('Function not implemented.');
    }
  }

  ChatFactory(fakeReadline, chatState).handler(question, chatState);

}

export const newChatSession = async (botId: string, question: string, context: Reactory.Server.IReactoryContext): Promise<ChatState> => {
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


