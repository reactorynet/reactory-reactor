import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorConversationsService, IOpenAIService, IReactorProviderService, IAIPersona, IAIProviderService, KnownAIProviders } from "../../types/service.types";
import ReactorConversationModel, { ReactorConversationDocument, TReactorConversationDocument, TReactorConversationModel, ValidProviderResponseTypes } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import AIPersonaProvider from "./AIPersonaProvider";
import ReactorMessageProcessingService from "./ReactorMessageProcessingService";
import { v4 } from "uuid";
import { ObjectId } from "mongodb";
import OpenAI from "openai";
import { MacroComponentDefinition, MacroToolDefinition, ToolApprovalMode } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/openai/chat/macro";
import GoogleAIService from "./providers/GoogleAIService";
import { ChatCompletion, ChatCompletionMessage } from "openai/resources";
import ReactorMacroService from "./providers/ReactorMacroService";

@service({
  id: "reactor.ReactorConversationService@1.0.0",
  name: "ReactorConversationService",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for managing reactor chat conversations",
  serviceType: "ai",
  dependencies: [
    { id: "reactor.OpenAIService@1.0.0", alias: "openaiService" },
    { id: "reactor.GoogleAIService@1.0.0", alias: "googleAIService" },
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" },
    { id: "reactor.ReactorMessageProcessingService@1.0.0", alias: "messageProcessingService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" }
  ],
})
export default class ReactorConversationService implements IReactorConversationsService {
  private context: Reactory.Server.IReactoryContext;
  private openaiService: IOpenAIService;
  private googleAIService: GoogleAIService;
  private providerService: IReactorProviderService;
  private personaProvider: AIPersonaProvider;
  private messageProcessingService: ReactorMessageProcessingService;
  private macroService: ReactorMacroService;
  
  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }


  async setChatToolApprovalMode(chatSessionId: string, toolApprovalMode: ToolApprovalMode): Promise<any> {
    // load the chat session
    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { toolApprovalMode },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(`Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`);
    }

    return chatState;
  }

  setOpenAIService(service: IOpenAIService) {
    this.openaiService = service;
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  setMessageProcessingService(service: ReactorMessageProcessingService) {
    this.messageProcessingService = service;
  }

  setMacroService(service: ReactorMacroService) {
    this.macroService = service;
  }

  async getConversations(filter: any): Promise<TReactorConversationModel[]> {
    const { personaId, userId, modelId } = filter || {};
    const query: any = {};
    
    // check if the user is logged in or an anoymous user.
    if (this.context.user) {
      if (this.context.user.anon) return [];
    } else {
      return [];
    }

    if (personaId) query.personaId = personaId;
    if (userId) query.userId = userId;
    if (modelId) query.modelId = modelId;
    
    // If no filter specified, get all conversations for current user
    if (!filter || Object.keys(filter).length === 0) {
      query.user = this.context.user;
    }
    
    return ReactorConversationModel.find(query).exec();
  }

  async getChatSession(args: { id: string }): Promise<TReactorConversationDocument> {
    const { id } = args;
    const session = await ReactorConversationModel.findOne({ _id: id }).exec();
    
    if (!session) {
      throw new Error('Chat session not found');
    }
    
    return session;
  }

  // Create a new conversation
  private async getNewConversation(persona: IAIPersona): Promise<TReactorConversationDocument> {
    // Check if the persona is valid
    if (!persona || !persona.id) {
      throw new Error('Invalid persona');
    }

    // Check if the user is valid
    if (!this.context.user) {
      throw new Error('User not found');
    }

    const sessionId = new ObjectId();
    const conversation  = new ReactorConversationModel({
      _id: sessionId,
      id: sessionId,
      personaId: persona.id,
      user: this.context.user,
      modelId: persona.modelId,
      providerId: persona.providerId,
      history: [],
      vars: {},
      meta: {
        summary: 'Reactor Chat Session with agent ' + persona.name,
        title: 'Chat with ' + persona.name,
      },
      macros: [],
      tools: [],
      started: new Date(),
      sseSessionId: sessionId,
      toolApprovalMode: ToolApprovalMode.PROMPT,
    }) as unknown as TReactorConversationDocument;
    
    await conversation.save();
  
    return conversation;
  }

  async sendMessage(args: { personaId: string, chatSessionId?: string, message: string }): Promise<any> {
    const { personaId, chatSessionId, message } = args;
    const { user } = this.context;
    
    try {
      // Get the persona's provider
      const persona = await this.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0", {
        chatSessionId
      }).getPersona(personaId);
      const provider = persona.providerId || "xai";
      
      // Save message to conversation history
      let conversation;
      if (chatSessionId) {
        conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();       
      }
      
      if (!conversation) {
        // Create new conversation
        const sessionId = new ObjectId();
        conversation = new ReactorConversationModel({
          _id: sessionId,
          id: sessionId,
          personaId,
          user,
          modelId: persona.modelId,
          providerId: provider,
          history: [],
          vars: {},
          meta: {
            summary: 'Reactor Chat Session with agent ' + persona.name,
            title: 'Chat with ' + persona.name,
          },
          macros: persona.macros || [],
          tools: persona.tools || [],
          started: new Date(),
          sseSessionId: sessionId, 
          toolApprovalMode: ToolApprovalMode.PROMPT,
        }); 
      }
      
      // Add user message
      // @ts-ignore
      conversation.history.push({
        id: new ObjectId(),
        role: "user",
        content: message,
        timestamp: new Date()
      });

      // Get provider adapter
      const adapter = await this.providerService.getAdapter(provider);
      
      let response: ChatCompletion;

      switch (provider) { 
        case "xai":
        case "openai":
          // x-ai and openai use the same service
          // first we need to initialize the openai service 
          // to use the correct model and connection parameters.
          await this.openaiService.initialize(chatSessionId, persona);
          response = await this.openaiService.chat({
            personaId,
            chatSessionId,
            message
          });

          // Add AI response if available
          if (response?.choices && response?.choices?.length > 0) {
            const aiMessage = response.choices[0].message;
            conversation.history.push({
              id: new ObjectId(),
              response, // add the original response for debugging
              role: aiMessage.role,
              content: aiMessage.content,
              timestamp: new Date(),
              tool_calls: aiMessage.tool_calls,
              tool_results: []
            });
          } else {
            this.context.warn(`No AI response received for message: ${message}`, { response });            
            conversation.history.push({
              id: new ObjectId(),
              role: "system",
              content: "No AI response received",
              timestamp: new Date(),
              tool_results: []
            });
          }
          // Add session ID to response
          // @ts-ignore
          response.sessionId = conversation._id.toString();
          // @ts-ignore
          await conversation.save();

          // process the tool calls if any exist.
          // tool calls will be called from the client
          // as it may require the user to approve the tool call.
          return adapter.adaptResponse(response);
        case "google":
          // Google AI service implementation
          await this.googleAIService.initialize(chatSessionId, persona);
          response = await this.googleAIService.chat({
            personaId,
            chatSessionId,
            message
          });

          // Add AI response if available
          if (response?.choices && response?.choices?.length > 0) {
            const aiMessage = response.choices[0].message;            
            conversation.history.push({
              id: new ObjectId(),
              response, // add the original response for debugging
              role: aiMessage.role,
              content: aiMessage.content,
              timestamp: new Date(),
              tool_calls: aiMessage.tool_calls,
              tool_results: aiMessage.tool_results || []
            });
          } else {
            this.context.warn(`No AI response received for message: ${message}`, { response });            
            conversation.history.push({
              id: new ObjectId(),
              role: "system",
              content: "No AI response received",
              timestamp: new Date(),
              tool_results: []
            });
          }
          // Add session ID to response
          // @ts-ignore
          response.sessionId = conversation._id.toString();

          return adapter.adaptResponse(response);

        default: {
          this.context.error(`Provider ${provider} not implemented`, { provider });
          throw new Error(`Provider ${provider} not implemented`);
        }
      }
    } catch (error) {
      this.context.error(`Error sending message: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "MESSAGE_ERROR",
        message: error.message || "Error sending message",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Please try again or check your connection"
      };
    }
  }


  async executeMacro(args: { 
    macro: string, 
    personaId: string, 
    chatSessionId: string,
    calledBy?: string,
    callId?: string,
    args?: any 
  }): Promise<any> {
    const { macro, personaId, chatSessionId, calledBy = 'assistant', callId = v4() } = args;
    
    try {
      // Get the persona's provider
      const persona = await this.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.providerId || "openai";
      
      // Get provider adapter
      const adapter = await this.providerService.getAdapter(provider);
      
      // Update conversation
      const conversation = await this.getChatSession({ id: chatSessionId });
      if (!conversation) {
        throw new Error('Conversation not found');
      }
           
      // check if the macro is available on the chat session
      let macroDef = conversation.macros.find((m) => m.name === macro);      
      if (macroDef === undefined || macroDef === null) {
        // check using the alias
        macroDef ??= (conversation as TReactorConversationDocument).macros.find((m: { alias: string }) => m.alias === macro);

        if (!macroDef) {
          // check the macro registry for the macro         
          if (!macroDef) {
            throw new Error(`Macro ${macro} not found in chat session`);
          }
        }
      }
      
      // check if the macro has roles and if the user has permission to execute
      // in theory this should not be needed as only macros that the user has access to should be available
      // to the user in the first place.
      if (macroDef.roles && macroDef.roles.length > 0) {
        const allowed = this.context.hasAnyRole(macroDef.roles);
        if (!allowed) {
          throw new Error(`User does not have permission to execute macro ${macro}`);
        }
      }

     
     
      // Execute the macro 
      const macroFunction = this.macroService.getMacro(macroDef.name);
      if (!macroFunction) {
        throw new Error(`Macro ${macro} not found in macro registry`);
      } 
      // @ts-ignore      
      let result = await macroFunction(args.args, conversation, this.context);
      if (!result) {
        throw new Error(`Macro ${macro} returned no result`);
      }
      
      // check if the results is plain string or an object
      if (typeof result === "string") {
        // return the string as a message
        result = {
          __typename: "ReactorChatMessage",
          role: calledBy,
          content: result,
          id: v4(),
          timestamp: new Date(),
          tool_calls: [],
          tool_results: [
            {
              id: callId,
              name: macro,
              type: "macro",
              content: result,
              timestamp: new Date(),
              props: args.args || {}
            }
          ]
        };
      } else if (typeof result !== "object") {
        throw new Error(`Macro ${macro} returned invalid result type`);
      }

      // Add macro result to conversation history
      conversation.history.push({
        role: calledBy,
        content: result.content,
        timestamp: new Date(),
        props: result.props,
        tool_calls: result?.tool_calls ?? []
      });
      
    
      await conversation.save();
      
      // Return adapted response
      return adapter.adaptResponse(result);
    } catch (error) {
      this.context.error(`Error executing macro: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "MACRO_ERROR",
        message: error.message || "Error executing macro",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Check if the macro exists and you have permission to execute it"
      };
    }
  }

  async executeTool(args: { 
    tool: string,
    toolArgs?: any, 
    personaId: string, 
    chatSessionId: string 
  }): Promise<any> {
    const { tool, personaId, chatSessionId } = args;
    
    try {
      // Similar implementation to executeMacro but for tools
      const persona = await this.context.getService("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.provider || "openai";
      const adapter = await this.providerService.getAdapter(provider);
      
     
      
      // Update conversation with tool execution
      const conversation = await this.getChatSession({ id: chatSessionId });
      if (!conversation) {
        throw new Error('Conversation not found');
      }
      
      // check if the is available on the chat session
      const toolDef = conversation.tools.find((t) => t.function.name === tool);
      if (!toolDef) {
        throw new Error(`Tool ${tool} not found in chat session`);
      }

      conversation.history.push({
        role: "system",
        content: `Executed tool: ${tool}`,
        timestamp: new Date()
      });
      
      if (response.choices && response.choices.length > 0) {
        const aiMessage = response.choices[0].message;
        conversation.history.push({
          role: aiMessage.role,
          content: aiMessage.content,
          timestamp: new Date(),
          tool_calls: aiMessage.tool_calls
        });
      }
      
      await conversation.save();
      
      return adapter.adaptResponse(response);
    } catch (error) {
      this.context.error(`Error executing tool: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "TOOL_ERROR",
        message: error.message || "Error executing tool",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Check if the tool exists and is properly configured"
      };
    }
  }

  async attachImage(args: { image: string, personaId: string, chatSessionId: string }): Promise<any> {
    const { image, personaId, chatSessionId } = args;
    
    try {
      const persona = await this.context.getService("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.provider || "openai";
      const adapter = await this.providerService.getAdapter(provider);
      
      // Add image to conversation
      const conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();
      if (!conversation) {
        throw new Error('Conversation not found');
      }
      
      // Add image message to history
      conversation.history.push({
        role: "user",
        content: "[Image attached]",
        timestamp: new Date(),
        imageData: image
      });
      
      // Process image with AI if supported
      let response;
      if (provider === "openai" && persona.modelId === "gpt-4-vision-preview") {
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message: "What do you see in this image?",
          image: image
        });
        
        if (response.choices && response.choices.length > 0) {
          const aiMessage = response.choices[0].message;
          conversation.history.push({
            role: aiMessage.role,
            content: aiMessage.content,
            timestamp: new Date(),
            tool_calls: aiMessage.tool_calls
          });
        }
      }
      
      await conversation.save();
      
      if (response) {
        return adapter.adaptResponse(response);
      } else {
        return {
          __typename: "ReactorChatMessage",
          id: Math.random().toString(36).substring(2, 15),
          role: "system",
          content: "Image attached successfully",
          timestamp: new Date()
        };
      }
    } catch (error) {
      this.context.error(`Error attaching image: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "IMAGE_ERROR",
        message: error.message || "Error attaching image",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Check image format and size"
      };
    }
  }

  async deleteChatSession(args: { id: string }): Promise<boolean> {
    const { id } = args;
    
    try {
      const result = await ReactorConversationModel.deleteOne({ _id: id, user: this.context.user }).exec();
      return result.deletedCount > 0;
    } catch (error) {
      this.context.error(`Error deleting chat session: ${error.message}`, { error });
      return false;
    }
  }

  async loadChatSession(chatSessionId: string): Promise<TReactorConversationDocument | null> {
    if (!chatSessionId) {
      throw new Error('Chat session ID is required');
    }

    // Load the chat session by ID
    const chatSession = await ReactorConversationModel.findOne({ _id: chatSessionId, user: this.context.user }).exec();
    
    if (!chatSession) {
      throw new Error(`Chat session with ID ${chatSessionId} not found or you do not have permission to access it.`);
    }

    return chatSession;
  }


  async startChatSession(args: { 
    personaId: string; 
    macros: Partial<MacroComponentDefinition<unknown>>[]; 
    tools: Partial<MacroToolDefinition>[]; }): Promise<TReactorConversationDocument> {
    const persona = await this.personaProvider.getPersona(args.personaId);
    if (!persona) {
      throw new Error(`Persona with id ${args.personaId} not found`);
    }

    const conversation = await this.getNewConversation(persona);
    if (!conversation) {
      throw new Error('Failed to create new conversation');
    }
    // add the macros and tools to the conversation
    if (args.macros) { 
      args.macros.forEach((macro) => { 
        conversation.macros.push({
          name: macro.name,
          nameSpace: macro.nameSpace,
          description: macro.description,
          version: macro.version,
          component: macro.component,
          runat: "client", // these are client side macros
          roles: macro?.roles ?? [],
          alias: macro.alias 
        });
      })
    }

    // only add the macros defined on the persona.
    persona.macros?.forEach((macro) => { 
      conversation.macros.push({        
        name: macro.name,
        nameSpace: macro.nameSpace,
        description: macro.description,
        version: macro.version,        
        runat: "server", // these are server side macros
        roles: macro.roles ?? [],
        alias: macro.alias || macro.name,
        enabled: macro.enabled ?? true,
      });
    });

    // add the client side tools to the conversation
    if (args.tools) { 
      args.tools.forEach((tool) => { 
        conversation.tools.push({
          type: tool.type ?? "function",
          runat: tool.runat ?? "client",
          enabled: tool.enabled ?? true,
          roles: tool.roles ?? [],
          function: tool.function,
        });
      })
    }

    // only add the tools defined on the persona.
    persona.tools?.forEach((tool) => { 
      conversation.tools.push({ 
        type: tool.type ?? "function",
        runat: tool.runat ?? "server", // these are server side tools
        enabled: tool.enabled ?? true,
        roles: tool.roles ?? [],
        function: tool.function,
      });
    });

    // Get the system prompt from the persona.
    const systemPromptTemplate = persona.prompts["system"];

    if (systemPromptTemplate) {
      // Add system prompt to conversation history
      const promptText = this.context.utils.lodash.template(systemPromptTemplate.content)({
        user: this.context.user,
        persona: persona,
        macros: conversation.macros,
        tools: conversation.tools,
        chatSessionId: conversation._id.toString(),
      });

      conversation.history.push({
        id: new ObjectId(),
        role: "system",
        content: promptText,
        timestamp: new Date(),
        tool_results: [],
      });
    }
    
    // @ts-ignore
    await conversation.save();

    return conversation;
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorConversationService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string = "Service for managing reactor chat conversations";
  tags?: string[] = ["ai", "chat", "conversations"];
  nameSpace: string = "reactor";
  name: string = "Reactor Conversation Service";
  version: string = "1.0.0";
}