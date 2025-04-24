import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import IOpenAIService, { AudioChatParams, ChatParams, CreateFineTuningJobParams, FineTuningEvent, FineTuningObjectJob, IAIPersona, IAIPersonaPromptTemplate, ImageExtensionParams, ImageGenerationParams, IOpenAIServiceProps, ListFineTuningJobParams, OpenAIFile, OpenAIImage, OpenAIListResponse, OpenAIModel } from "../../../types/service.types";
import OpenAI, { ClientOptions } from "openai";
import AIPersonaProvider from "../AIPersonaProvider";
import { ChatState, MacroComponentDefinition, MacroToolDefinition, ToolApprovalMode } from "../../../ai/openai/types/chat";
import fs from "fs";
import { ChatCompletionTool, CompletionChoice } from "openai/resources";
import Mongoose from "mongoose";
import ReactorConversationModel, { TReactorConversationModel } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

import {
  handleUserResponse,
  handleChatCompletionResponse,
  MacroRegistry,
  handleCommandAction,
} from "../../../ai/openai/chat/macro";


@service({
  id: "reactor.OpenAIService@1.0.0",
  name: "OpenAI Service",
  nameSpace: "reactor",
  description: "Service for managing OpenAI API requests",
  serviceType:  "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },  
  ],
})
class OpenAIService implements IOpenAIService {
  
  context: Reactory.Server.IReactoryContext;
  props: IOpenAIServiceProps;
  ai: OpenAI;
  fileService: Reactory.Service.IReactoryFileService;
  userService: Reactory.Service.IReactoryUserService;
  fetchService: Reactory.Service.IFetchService;
  personaProvider: AIPersonaProvider;
  // keep a local copy of the chat state model
  // for the duration of the service to reduce 
  // the number of calls to the database to load 
  // the chat state model
  chatStateModel: Mongoose.Document;
  // chat state object used by the service during the
  // lifecycle of the service
  chatState: ChatState;

  constructor(props: IOpenAIServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.props = props;
  }

  /**
   * Persists the chat state to the database
   * @param state 
   */
  private async persistChatState(): Promise<void> {
    const { history, personaId, modelId, started, context, id, sseSession, persona, vars } = this.chatState;
    const { user } = context;
    const meta = {
      summary: "Chat session with Reactor",
      title: `Chat session with Reactor`,
    };

    try {
      let nextStateModel = null;
      if (this.chatStateModel !== null && this.chatStateModel._id.toString() === id &&
        this.chatStateModel.user._id.toString() === user._id.toString()) {
        nextStateModel = this.chatStateModel;
      }
      if (!nextStateModel) {
        nextStateModel = new ReactorConversationModel({
          _id: id,
          id,
          personaId,
          modelId,
          started,
          history,
          sseSessionId: sseSession,
          user,
          vars,
          created: new Date(),
          updated: new Date(),
          meta
        });
        await nextStateModel.save();
      } else {
        // check if the user matches the one in the chat state
        if (nextStateModel.user && nextStateModel.user._id.toString() !== user._id.toString()) {
          // throw an error if the user does not match
          throw new Error(`User ${user._id.toString()} does not match chat state user ${nextStateModel.user._id.toString()}`);
        } else {
          nextStateModel.history = history;
          nextStateModel.updated = new Date();
          nextStateModel.sseSessionId = sseSession;
          await nextStateModel.save();
        }

        this.chatStateModel = nextStateModel;

      }
    } catch (error) {
      this.context.error(
        `Error persisting chat state: ${error.message || error.toString()}`,
        { error },
        'OpenAIService.persistChatState'
      );
      throw new Error('Failed to persist chat state');
    }
  }

  /**
   * Loads a chat state from the database or creates a new one if it doesn't exist
   * @param chatSessionId Optional chat session ID
   * @returns Boolean indicating if this is a new chat session
   */
  private async loadChatState(chatSessionId?: string): Promise<boolean> {
    const { context } = this;
    
    // Generate a new ID if none provided
    if (!chatSessionId) {
      chatSessionId = new Mongoose.Types.ObjectId().toString();
      this.chatStateModel = null;
      return true; // This is a new chat session
    }
    
    try {
      // Load existing chat session
      const chatSession = await ReactorConversationModel.findById(chatSessionId);
      
      if (!chatSession) {
        // Chat session ID was provided but not found
        this.chatStateModel = null;
        return true;
      }
      
      // Verify ownership of the chat session
      if (chatSession.user && chatSession.user._id.toString() !== context.user._id.toString()) {
        throw new Error(`Chat session ${chatSessionId} does not belong to user ${context.user._id.toString()}`);
      }
      
      // Set the chat state model
      // @ts-ignore
      this.chatStateModel = chatSession;
      
      // Set the chat state from the model
      this.chatState = {
        id: chatSession._id.toString(),
        user: context.user,
        modelId: chatSession.modelId,
        started: chatSession.started,
        history: chatSession.history,
        apiKey: process.env.OPENAI_API_KEY || "",
        apiOrg: process.env.OPENAI_ORG || "",
        ai: this.ai,
        personaId: chatSession.personaId,
        persona: this.personaProvider?.getPersona(chatSession.personaId),
        macros: MacroRegistry,
        vars: chatSession.vars || {},
        sseSession: chatSession.sseSessionId,
        toolApprovalMode: (process.env.TOOL_APPROVAL_MODE as ToolApprovalMode) || ToolApprovalMode.PROMPT,
      };
      
      return false; // This is an existing chat session
    } catch (error) {
      if (error.message.includes('does not belong to user')) {
        throw error; // Rethrow ownership errors
      }
      
      this.context.error(
        `Error loading chat state: ${error.message || error.toString()}`,
        { error, chatSessionId },
        'OpenAIService.loadChatState'
      );
      
      // Fall back to creating a new session
      this.chatStateModel = null;
      return true;
    }
  }

  public async initialize(chatSessionId: string, persona: IAIPersona) {
    // Set up OpenAI client
    const {
      apiKey,
      apiOrganizationId,
      apiBaseURL,
    } = this.props;
    
    const openAIArgs: ClientOptions = {
      apiKey: `${apiKey || process.env.OPENAI_API_KEY}`,
      organization: apiOrganizationId,
      baseURL: `${apiBaseURL || process.env.OPENAI_API_BASE_URL}`
    };

    // Apply any provider-specific configuration
    if (openAIArgs.baseURL.indexOf("x.ai") > -1) {
      delete openAIArgs.organization;
    }
    
    // Apply persona-specific configuration if available
    if (persona.config) {
      if (persona.config.apiKey) openAIArgs.apiKey = persona.config.apiKey;
      if (persona.config.apiOrg) openAIArgs.organization = persona.config.apiOrg;
      if (persona.config.apiBaseURL) openAIArgs.baseURL = persona.config.apiBaseURL;
    }
    
    // Initialize OpenAI client
    this.ai = new OpenAI(openAIArgs);

    // Load or create chat state
    const isNewSession = await this.loadChatState(chatSessionId);
    
    // For new sessions, initialize with system prompt
    if (isNewSession) {
      // Validate persona has system prompt
      if (!persona.prompts || !persona.prompts["system"]) {
        throw new Error("Persona does not have a system prompt");
      }
      
      // Create system prompt message
      const promptTemplate: IAIPersonaPromptTemplate = persona.prompts["system"];
      const SYSTEM_INITIALIZER_MESSAGE: any = {
        role: "system",
        content: this.context.utils.lodash.template(promptTemplate.content)({
          persona: persona,
          tools: this.getToolsDefinitions(),
          macros: MacroRegistry,
          user: {
            id: this.context.user.id, 
            fullName: this.context.user.fullName(false),
            firstName: this.context.user.firstName,
            lastName: this.context.user.lastName,
          },
        }),
      };
      
      // Set model ID
      const modelId = persona.modelId || process.env.OPENAI_MODEL_ID;
      if (!modelId) {
        throw new Error("Model ID is not set, set config for the environment or for the persona");
      }
      
      // Initialize new chat state
      this.chatState = {
        id: chatSessionId,
        user: this.context.user,
        modelId,
        started: new Date(),
        history: [SYSTEM_INITIALIZER_MESSAGE],
        apiKey: process.env.OPENAI_API_KEY || "",
        apiOrg: process.env.OPENAI_ORG || "",
        ai: this.ai,
        personaId: persona.id,
        persona,
        macros: MacroRegistry,
        vars: {},
        toolApprovalMode: (process.env.TOOL_APPROVAL_MODE as ToolApprovalMode) || ToolApprovalMode.PROMPT,
      };
    }
  }

  chatAudio(params: AudioChatParams): Promise<ChatCompletionResponseMessage> {
    throw new Error("Method not implemented.");
  }

  speech2Text(audio: string | Buffer[]): Promise<string> {
    throw new Error("Method not implemented.");
  }

  createFineTuningJob(params: CreateFineTuningJobParams): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  listFineTuningJobs(params: ListFineTuningJobParams): Promise<FineTuningObjectJob[]> {
    throw new Error("Method not implemented.");
  }
  getFineTuningJob(jobId: string): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  cancelFineTuningJob(jobId: string): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  listFineTuningEvents(jobId: string): Promise<FineTuningEvent[]> {
    throw new Error("Method not implemented.");
  }
  listFiles(): Promise<OpenAIFile[]> {
    throw new Error("Method not implemented.");
  }
  uploadFile(filename: string, purpose: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  deleteFile(fileId: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  getFile(fileId: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  getFileContents(fileId: string): Promise<string> {
    throw new Error("Method not implemented.");
  }
  generateImage(params: ImageGenerationParams): Promise<OpenAIListResponse<OpenAIImage>> {
    throw new Error("Method not implemented.");
  }
  extendImage(params: ImageExtensionParams): Promise<OpenAIListResponse<OpenAIImage>> {
    throw new Error("Method not implemented.");
  }
  listModels(): Promise<OpenAIListResponse<OpenAIModel>> {
    throw new Error("Method not implemented.");
  }


  /**
   * This is a placeholder function to handle the selection of choices from a list of responses.
   */
  async makeSelectionFromChoices(choices: OpenAI.Chat.ChatCompletion.Choice[], state: ChatState): Promise<number> {
    
    // use the SSE client connetion to send
    // the choices to the user and wait for a response
    const choicesString = choices.map((choice, index) => `${index + 1}: ${choice.message.content}`).join("\n");
    
    const result = await state.sseSession.send({
      type: "choices",
      data: {
        choices: choicesString,
        message: "Please select a choice by number:"
      }
    });

    if(result.type === "choices") { 
      const choiceIndex = parseInt(result.data);
      return choiceIndex - 1;
    } else {
      return 0;
    }
  }


  /**
   * This function will handle the completion response from the openai api
   * @param response 
   * @param prompt 
   * @param state 
   * @returns 
   */
  async handleChatCompletionResponse(
    response: OpenAI.Chat.Completions.ChatCompletion, 
    prompt: OpenAI.ChatCompletionCreateParams,
    state: ChatState
    ): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice & { __index: number }> {
  
    // Clone the response to avoid mutating the original object
    const cloned: OpenAI.Chat.Completions.ChatCompletion = JSON.parse(JSON.stringify(response));
    // first we check if there is a macro block definition
    // which is recognise by the characters ```rfm as the start of the block and ``` as the end of the block
    // const macroBlockRegex = /```rfm([\s\S]*?)```/g;
    let choice_index = 0;  
    // if there is more than one choice we need display a short summary of each choice
    // and then ask the user to select one of the choices to display the full text  
    if(cloned.choices.length > 1) { 
      let validChoice = false;
      while(!validChoice) { 
        choice_index = await this.makeSelectionFromChoices(cloned.choices, state);
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

  private getMacroRegistry(): MacroComponentDefinition<unknown>[] {
    // convert the macro registry to a list of tools
    const { hasRole } = this.context;
    const macros: MacroComponentDefinition<unknown>[] = [];
  
    MacroRegistry.forEach((macro: MacroComponentDefinition<unknown>) => {
      let hasAccess = false;
      if (macro.roles && macro.roles.length > 0) { } 
      else hasAccess = true;
      if (macro.tools && hasAccess === true) {
        macros.push(macro);
      }
    });
  
    return macros;
  }

  private getToolsDefinitions(): ChatCompletionTool[] {
    // convert the macro registry to a list of tools
    const { context } = this;
    const tools: any[] = [];
  
    MacroRegistry.forEach((macro: MacroComponentDefinition<unknown>) => {
      let hasAccess = false;
      if (macro.roles && macro.roles.length > 0) { 
        hasAccess = context.hasAnyRole(macro.roles);
        if (hasAccess === false) {
          return;
        }
      } 
      else hasAccess = true;
      
      if (macro.tools && hasAccess === true) {
        macro.tools.forEach((tool: MacroToolDefinition) => {
          if (tool.type === "function") {
            const { function: func } = tool;
            const toolDefinition = {
              type: "function",
              function: {
                name: func.name,
                description: func.description || "",
                parameters: func.parameters,
              }
            };
            tools.push(toolDefinition);
          }
        });
      }
    });
  
    return tools;
  }

  private createPrompt(    
    message: string,    
  ): OpenAI.Chat.Completions.ChatCompletionCreateParams {

    const { context, chatState } = this;
    const { history, modelId } = chatState;

    let messages: any[] = [
      ...history,
      {
        role: "user",
        content: message,
      },
    ];
  
    const tools = this.getToolsDefinitions();
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

  private async getAIResponse(
    prompt: OpenAI.Chat.ChatCompletionCreateParams,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { ai } = this;
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
      
      // @ts-ignore
      return completion;
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message || error.toString()}`, 
        { error },
        'OpenAIService')
    }
  }

  async chat(params: ChatParams): Promise<OpenAI.Chat.Completions.ChatCompletion> { 
    const { personaId, chatSessionId, message } = params;
    const {
      createPrompt,
      getAIResponse,
      handleChatCompletionResponse,
      persistChatState, 
      chatState
    } = this;
    // check the chat session id vs the chat state id
    // if they are not the same we need to load the chat state from the database

    
    // create the prompt from the user input.
    const prompt = this.createPrompt(message);

    // get the response from the AI
    return await this.getAIResponse(prompt);    
  }

  // add setters for service dependencies
  setFileService(fileService: Reactory.Service.IReactoryFileService) {
    this.fileService = fileService;
  }
  setUserService(userService: Reactory.Service.IReactoryUserService) {
    this.userService = userService;
  }
  setFetchService(fetchService: Reactory.Service.IFetchService) {
    this.fetchService = fetchService;
  }
  setPersonaProvider(personaProvider: AIPersonaProvider) {
    this.personaProvider = personaProvider;
  }

  toString?(includeVersion?: boolean): string {
    throw new Error("Method not implemented.");
  }

  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;
}

export default OpenAIService;
