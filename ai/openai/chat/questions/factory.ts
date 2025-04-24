import { Interface, ReadLine } from "readline";
import fs from "fs";
import OpenAI from "openai";
import {
  ChatState,
  IQuestion,
  IToolCallResponse,
  Macro,
  MacroComponentDefinition,
  RatedChatCompletionResponseMessage,
  ToolApprovalMode,
} from "modules/reactory-reactor/ai/openai/types/chat";
import {
  handleUserResponse,
  handleChatCompletionResponse,
  MacroRegistry,
  handleCommandAction,
} from "../macro";
import { colors } from "../../../../helpers";
import ReactorConversationModel from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { get, template } from "lodash";
import { RecordNotFoundError } from "@reactory/server-core/exceptions";
import { ChatCompletionMessage } from "openai/resources/chat/completions/completions";
import uuid from "uuid";
export const SYSTEM_INITIALIZER_MESSAGE: any = {
  role: "system",
  content: fs.readFileSync(require.resolve('../macro/macros.md'), 'utf-8').toString(),
};

export const getInitializerMessage = async (
  botId: string,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<Partial<ChatCompletionMessage>> => {
  const personaService = context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0");
  const persona = await personaService.getPersona(botId);
  const macros = state.macros
    .map((macro) => `## ${macro.name}\n ## Usage\n${macro.description}`)
    .join("\n");

  if (persona) {
    context.info(`Found persona for botId: ${botId}`);
    return {
      id: uuid.v4(),
      role: SYSTEM_INITIALIZER_MESSAGE.role,
      content: template(SYSTEM_INITIALIZER_MESSAGE.content)({
        macros,
        persona: persona.persona,
        features: persona.features,
      }),
    };
  } else {
    context.warn(`No persona found for botId: ${botId}`);
    return {
      role: SYSTEM_INITIALIZER_MESSAGE.role,
      content: template(SYSTEM_INITIALIZER_MESSAGE.content)({
        macros,
        persona: `You are a default neautral persona with no specific features`,
        features: `You answer questions in in a neutral way and have no specific features or `,
      }),
    }
  };
};

export const INITIAL_CHAT_STATE: ChatState = {
  modelId: process.env.OPENAI_MODEL_ID || "",
  started: new Date(),
  history: [SYSTEM_INITIALIZER_MESSAGE],
  apiKey: process.env.OPENAI_API_KEY || "",
  apiOrg: process.env.OPENAI_ORG || "",
  ai: new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // organization: process.env.OPENAI_ORG
    baseURL: process.env.OPENAI_BASE_URL,
  }),
  personaId: "Reactor",
  persona: null,
  macros: MacroRegistry,
  vars: {},
  toolApprovalMode: (process.env.TOOL_APPROVAL_MODE as ToolApprovalMode) || ToolApprovalMode.PROMPT,
};

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
};

export const persistChatState = async (state: ChatState): Promise<void> => {
  const { history, personaId: botId, modelId, started, context, id } = state;
  const { user } = context;
  const meta = {
    summary: "Chat session with Reactor",
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
};

export function getToolsDefinitions(): any[] {
  // convert the macro registry to a list of tools
  const tools: any[] = [];

  MacroRegistry.forEach((macro: MacroComponentDefinition<unknown>) => {
    if (macro.tools) {
      tools.push(...macro.tools);
    }
  });

  return tools;
}

export function createPrompt(
  modelId: string,
  message: string,
  history: any[],
  role?: string
): OpenAI.ChatCompletionCreateParams {
  let messages: any[] = [
    ...history,
    {
      role: role || "assistant",
      content: message,
    },
  ];

  const tools = getToolsDefinitions();
  if (tools.length > 0) {
    return {
      model: modelId,
      messages: messages,
      tools: tools,
      tool_choice: "auto",
    };
  } else {
    return {
      model: modelId,
      messages: messages,
    };
  }
}

/**
 * Processes tool calls in the AI response
 */
export async function processToolCalls(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  state: ChatState,
  choiceIndex: number = 0
): Promise<IToolCallResponse[]> {
  const tools = getToolsDefinitions();
  if (tools.length === 0) return [];

  const results: IToolCallResponse[] = [];
  const message = completion.choices[choiceIndex]?.message;
  if (!message) {
    console.error("No message found in completion choice");
    return results;
  }

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall.id || !toolCall.function) {
        console.error("Invalid tool call structure");
        continue;
      }

      const tool = tools.find(
        (toolDef) => {
          return toolDef.function.name === toolCall.function.name 
        }
      );
      if (!tool) {
        results.push({
          role: "tool",
          content: `Tool not found for tool call: ${toolCall.function.name}`,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      const macroDefinition = MacroRegistry.find(
        (macro) => { 
          if(tool.function.name.indexOf('.') > -1) {
            const fqn = `${macro.nameSpace}.${macro.name}${tool.function.name.indexOf('@') > -1 ? '@'+macro.version: ''}`;
            return fqn === tool.function.name;
          }
          return macro.name === tool.function.name;
        }
      );
      if (!macroDefinition) {
        results.push({
          role: "tool",
          content: `Macro not found for tool: ${tool.function.name}`,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      let args: any = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (error) {
        results.push({
          role: "tool",
          content: `Error parsing tool arguments: ${error.message}`,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      const toolName = tool.function.name;
      const approvalMode = state.toolApprovalMode || ToolApprovalMode.PROMPT;

      // Handle different approval modes
      if (approvalMode === ToolApprovalMode.AUTO) {
        // Auto-approve all tools
        const response = await executeToolCall(toolCall, toolName, args, macroDefinition, state);
        results.push({
          role: "tool",
          content: response,
          tool_call_id: toolCall.id,
        });
      } else if (approvalMode === ToolApprovalMode.SAFE_AUTO && isSafeTool(toolName)) {
        // Auto-approve safe tools
        const response = await executeToolCall(toolCall, toolName, args, macroDefinition, state);
        results.push({
          role: "tool",
          content: response,
          tool_call_id: toolCall.id,
        });
      } else {
        // Require explicit user approval
        const { rl } = state;
        if (!rl) {
          results.push({
            role: "tool",
            content: "Cannot execute tool: No readline interface available for user confirmation",
            tool_call_id: toolCall.id,
          });
          continue;
        }

        try {
          const executeWithApproval = () => {
            return new Promise<void>((resolve) => {
              rl.question(
                `Do you want to run the tool: ${toolName} with arguments ${JSON.stringify(args.args)}? (y/n): `,
                async (answer) => {
                  if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
                    const response = await executeToolCall(toolCall, toolName, args, macroDefinition, state);
                    results.push({
                      role: "tool",
                      content: response,
                      tool_call_id: toolCall.id,
                    });
                  } else {
                    results.push({
                      role: "tool",
                      content: `Tool call cancelled by user: ${toolName}`,
                      tool_call_id: toolCall.id,
                    });
                  }
                  resolve();
                }
              );
            });
          };
          
          await executeWithApproval();
        } catch (error) {
          results.push({
            role: "tool",
            content: `Error during tool approval: ${error.message}`,
            tool_call_id: toolCall.id,
          });
        }
      }
    }
  }
  return results;
}

/**
 * Executes a tool call with appropriate approval process
 */
async function executeToolCall(
  toolCall: any,
  toolName: string,
  args: any,
  macroDefinition: MacroComponentDefinition<unknown>,
  state: ChatState
): Promise<string> {
  try {
    const macro = (await (macroDefinition).component) as Macro<unknown>;
    let response: any = "";
    
    if (args.args && Array.isArray(args.args)) {
      response = await macro(args.args || [], state);
    } else {
      if (args && Array.isArray(args)) {
        response = await macro(args, state);
      } else {
        response = await macro([], state);
      }
    } 

    return response as string;
  } catch (error) {
    return `Error in tool call ${toolName}: ${error.message}`;
  }
}

/**
 * Determines if a tool is safe for automatic execution
 * Can be extended with more sophisticated checks
 */
function isSafeTool(toolName: string): boolean {
  const safeMacros = [
    'readFile', 
    'listDirectory', 
    'pathInfo',
  ]; // These are read-only operations
  const dangerousMacros = [
    'writeFile',
    'rmdir', 
    'mkdir', 
    'shell',
    'env',
    'get',
    'post',
    'put',
    'delete',
    'patch',
  ]; // These modify the filesystem
  
  return safeMacros.includes(toolName) && !dangerousMacros.includes(toolName);
}

export async function getAIResponse(
  ai: OpenAI,
  prompt: OpenAI.ChatCompletionCreateParams,
  state: ChatState
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  try {
    // Filter out any messages with empty content
    if (prompt.messages && Array.isArray(prompt.messages)) {
      prompt.messages = prompt.messages.filter(
        (msg: OpenAI.ChatCompletionMessageParam) =>
          msg?.content &&
          typeof msg.content === "string" &&
          msg?.content.trim() !== ""
      );

      // If there are no valid messages after filtering, add a default message
      if (
        prompt.messages.length === 0 ||
        !prompt.messages.some(
          (msg: OpenAI.ChatCompletionMessageParam) => msg.role === "user"
        )
      ) {
        throw new Error("No valid messages found in prompt");
      }
    }

    const completion = (await ai.chat.completions.create(
      prompt
    )) as OpenAI.Chat.Completions.ChatCompletion;
    const parsed = await handleChatCompletionResponse(
      completion,
      prompt,
      state
    );
    const { message } = completion.choices[parsed.__index];
    if (message?.tool_calls?.length > 0) {
      const results: IToolCallResponse[] = await processToolCalls(
        completion,
        state,
        parsed.__index
      );
      if (results?.length > 0) {
        prompt.messages.push(...results);
        return await getAIResponse(ai, prompt, state);
      }
    }

    // @ts-ignore
    return [parsed.message];
  } catch (error) {
    console.error("Error getting AI response:", error);
    return [
      {
        role: "assistant",
        content: `I'm sorry, I couldn't process that. ${error.message}`,
      },
    ];
  }
}

// Prune the history to respect OpenAI API limits
const pruneHistory = (history: any[]): any[] => {
  const MAX_TOKENS = 4096;
  let totalTokens = 0;

  // Reverse history so that we start counting from the most recent messages
  const reversedHistory = [...history].reverse();

  const prunedHistory = reversedHistory.filter((message) => {
    totalTokens += message?.content?.split(" ")?.length || 0; // Approximate token count
    return totalTokens <= MAX_TOKENS;
  });

  // Return it to the original order
  return prunedHistory.reverse();
};

const memoryReadline: ReadLine = {
  write: (message: string) => {
    console.log(message);
  },
  question: (question: string, callback: (answer: string) => void) => {
    callback(question);
  },
  terminal: false,
  line: "",
  cursor: 0,
  setPrompt: function (prompt: string): void {
    throw new Error("Function not implemented.");
  },
  prompt: function (preserveCursor?: boolean): void {
    throw new Error("Function not implemented.");
  },
  pause: function (): Interface {
    throw new Error("Function not implemented.");
  },
  resume: function (): Interface {
    throw new Error("Function not implemented.");
  },
  close: function (): void {
    throw new Error("Function not implemented.");
  },
  addListener: function (
    event: string,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  emit: function (event: string | symbol, ...args: any[]): boolean {
    throw new Error("Function not implemented.");
  },
  on: function (
    event: string,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  once: function (
    event: string,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  prependListener: function (
    event: string,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  prependOnceListener: function (
    event: string,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  removeListener: function (
    event: string | symbol,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  off: function (
    event: string | symbol,
    listener: (...args: any[]) => void
  ): Interface {
    throw new Error("Function not implemented.");
  },
  removeAllListeners: function (event?: string | symbol): Interface {
    throw new Error("Function not implemented.");
  },
  setMaxListeners: function (n: number): Interface {
    throw new Error("Function not implemented.");
  },
  getMaxListeners(): number {
    throw new Error("Function not implemented.");
  },
  listeners: function (event: string | symbol): Function[] {
    throw new Error("Function not implemented.");
  },
  rawListeners: function (event: string | symbol): Function[] {
    throw new Error("Function not implemented.");
  },
  listenerCount: function (type: string | symbol): number {
    throw new Error("Function not implemented.");
  },
  eventNames: function (): (string | symbol)[] {
    throw new Error("Function not implemented.");
  },
};

class FakeReadLine implements ReadLine {
  private buffer: string[] = [];
  private callback: ((answer: string) => void) | null = null;

  write(message: string): void {
    console.log(message);
  }

  question(question: string, callback: (answer: string) => void): void {
    console.log(question);
    this.callback = callback;
  }

  simulateInput(input: string): void {
    if (this.callback) {
      this.callback(input);
      this.callback = null;
    } else {
      this.buffer.push(input);
    }
  }

  // Unimplemented methods
  terminal = false;
  line = "";
  cursor = 0;
  setPrompt(prompt: string): void {}
  prompt(preserveCursor?: boolean): void {}
  pause(): Interface {
    return this;
  }
  resume(): Interface {
    return this;
  }
  close(): void {}
  addListener(event: string, listener: (...args: any[]) => void): Interface {
    return this;
  }
  emit(event: string | symbol, ...args: any[]): boolean {
    return false;
  }
  on(event: string, listener: (...args: any[]) => void): Interface {
    return this;
  }
  once(event: string, listener: (...args: any[]) => void): Interface {
    return this;
  }
  prependListener(event: string, listener: (...args: any[]) => void): Interface {
    return this;
  }
  prependOnceListener(event: string, listener: (...args: any[]) => void): Interface {
    return this;
  }
  removeListener(event: string | symbol, listener: (...args: any[]) => void): Interface {
    return this;
  }
  off(event: string | symbol, listener: (...args: any[]) => void): Interface {
    return this;
  }
  removeAllListeners(event?: string | symbol): Interface {
    return this;
  }
  setMaxListeners(n: number): Interface {
    return this;
  }
  getMaxListeners(): number {
    return 0;
  }
  listeners(event: string | symbol): Function[] {
    return [];
  }
  rawListeners(event: string | symbol): Function[] {
    return [];
  }
  listenerCount(type: string | symbol): number {
    return 0;
  }
  eventNames(): (string | symbol)[] {
    return [];
  }
}

export const askQuestion = async (
  chatSessionId: string,
  question: string,
  context: Reactory.Server.IReactoryContext
): Promise<ChatCompletionMessage> => {
  //load session from database
  const conversationModel = await ReactorConversationModel.findById(
    chatSessionId
  ).exec();

  if (conversationModel === null)
    throw new RecordNotFoundError(
      `Chat session with id ${chatSessionId} not found`
    );

  const chatState: ChatState = {
    ai: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
    apiKey: process.env.OPENAI_API_KEY || "",
    apiOrg: process.env.OPENAI_ORG || "",
    personaId: conversationModel.botId,
    history: conversationModel.history,
    id: conversationModel.id,
    macros: MacroRegistry,
    modelId: conversationModel.modelId,
    persona: await context
      .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
      ?.getPersona(conversationModel.botId),
    started: conversationModel.started,
    vars: conversationModel.vars,
    context,
    authToken: "",
    created: conversationModel.created,
    updated: conversationModel.updated,
  };

  ChatFactory(memoryReadline, chatState).handler(question, chatState);
};

// new Chat session is used to start a new chat session
// this will create a new chat session in the database
// and return the chat session id
export const newChatSession = async (
  personaId: string,
  message: string,
  context: Reactory.Server.IReactoryContext
): Promise<any> => {
  const personaService = context.getService<AIPersonaProvider>(
    "reactor.AIPersonaProvider@1.0.0"
  ) as AIPersonaProvider;

  const persona = await personaService.getPersona(personaId);
  if (!persona) {
    throw new Error(`Persona with ID ${personaId} not found`);
  }

  const chatState: ChatState = {
    ...INITIAL_CHAT_STATE,
    personaId: personaId,
    persona,
    context,
    history: [SYSTEM_INITIALIZER_MESSAGE],
  };

  const fakeReadLine = new FakeReadLine();
  const chatFactory = ChatFactory(fakeReadLine, chatState);

  fakeReadLine.simulateInput(message);
  await chatFactory.handler(message, chatState);
};


/**
 * The chat factory function provvides is a factory function that creates a new chat session
 * or continues an existing chat session. It takes a readline interface and a chat state as input.
 * @param rl 
 * @param state 
 * @returns 
 */
export const ChatFactory = (
  rl: ReadLine,
  state: ChatState = INITIAL_CHAT_STATE
): IQuestion => {
  const { modelId, started, ai, context } = state;

  const { user } = context;

  let question =
    state.history.length === 1
      ? `Hi ${
          user?.firstName ? user.firstName : "Anon"
        }, how can we build better applications today with reactory?`
      : "";

  // check if the last message was a question
  // if it is, we clear the default question
  if (state.history.length > 1) {
    if (state.history[state.history.length - 1].content?.includes("?")) {
      question = "";
    }
  }
  let prompt: OpenAI.ChatCompletionCreateParams = createPrompt(
    modelId,
    question,
    state.history
  );

  return {
    question,
    handler: async (response: string, state: ChatState) => {
      // Add the command's response to the messages
      const userInput: any = {
        role: "user",
        content: response,
      };

      const getNextState = () => {
        // Add the old chat's history to the new chat's state
        const prunedHistory = pruneHistory(state.history);
        let nextState = { ...state };
        nextState.history = prunedHistory;
        return nextState;
      };

      state.history.push(userInput);
      let nextState = getNextState();

      let messages: any & { rating?: number }[] = []; // The AI's response or the system comamnd response
      if (response.indexOf("/") === 0) {
        // handle command message
        const commandResult = await handleCommandAction(response, nextState);
        // @ts-ignore
        nextState.history.push(commandResult);
        prompt.messages.push(commandResult);
        messages.push(commandResult);
      } else {
        userInput.content = await handleUserResponse(response, state);
        // Add the user's response to the messages
        prompt.messages.push(userInput);
        // Get AI's response
        messages = await getAIResponse(ai, prompt, nextState);
        // Add the AI's response to the messages
      }      
      prompt.messages = [...prompt.messages, ...messages];

      //@ts-ignore
      nextState.history = prompt.messages;
      // Display the AI's response
      const { persona } = state;
      messages.forEach((message: any) => {
        if (message.role === "assistant") {
          const lines = message.content.split('\n');
          const formattedMessage = lines.map((line: string, index: number) => {
            if (index === 0) {
              return `${colors.yellow(`[${persona.name}]>`)}${colors.green(line)}`;
            } else {
              return colors.green(line);
            }
          }).join('\n');
          rl.write(formattedMessage + '\n');
        }

        if (message.role === "tool") {
          const lines = message.content.split('\n');
          const formattedMessage = lines.map((line: string, index: number) => {
            if (index === 0) {
              return `${colors.yellow(`[Tool]>`)}${colors.green(line)}`;
            } else {
              return colors.green(line);
            }
          }).join('\n');
          rl.write(formattedMessage + '\n');
        }
      });
      // if reactor is running in training mode, we want to prompt the user to give a rating for the response
      if (process.env.OPENAI_TRAINING_MODE === "true") {
        const rateResponse = async (
          aiResponseMessage: any,
          state: ChatState
        ): Promise<RatedChatCompletionResponseMessage> => {
          return new Promise((resolve, reject) => {
            const ratedMessage = { ...aiResponseMessage, rating: 0 };
            if (ratedMessage.content.length > 0) {
              rl.question(
                `${colors.yellow(`[${botId}]>`)}${colors.green(
                  `How would you rate this response? (1-10)`
                )}\n`,
                (rating) => {
                  if (rating && rating.length > 0) {
                    try {
                      ratedMessage.rating = parseInt(rating, 10);
                      resolve(ratedMessage);
                    } catch (error) {
                      reject(error);
                    }
                  }
                }
              );
            }
          });
        };

        try {
          const ratedMessage = await rateResponse(messages, state);
          // @ts-ignore
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
      };
    },
  };
};
