import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorConversationsService, IOpenAIService, IReactorProviderService } from "../../types/service.types";
import ReactorConversationModel, { TReactorConversationModel } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

@service({
  id: "reactor.ReactorConversationService@1.0.0",
  name: "Reactor Conversation Service",
  nameSpace: "reactor",
  description: "Service for managing reactor chat conversations",
  serviceType: "ai",
  dependencies: [
    { id: "reactor.OpenAIService@1.0.0", alias: "openaiService" },
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" }
  ],
})
export default class ReactorConversationService implements IReactorConversationsService {
  private context: Reactory.Server.IReactoryContext;
  private openaiService: IOpenAIService;
  private providerService: IReactorProviderService;
  
  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  setOpenAIService(service: IOpenAIService) {
    this.openaiService = service;
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  async getConversations(filter: any): Promise<TReactorConversationModel[]> {
    const { personaId, userId, modelId } = filter || {};
    const query: any = {};
    
    if (personaId) query.personaId = personaId;
    if (userId) query.userId = userId;
    if (modelId) query.modelId = modelId;
    
    // If no filter specified, get all conversations for current user
    if (!filter || Object.keys(filter).length === 0) {
      query.user = this.context.user;
    }
    
    return ReactorConversationModel.find(query).exec();
  }

  async getChatSession(args: { id: string }): Promise<TReactorConversationModel> {
    const { id } = args;
    const session = await ReactorConversationModel.findOne({ _id: id }).exec();
    
    if (!session) {
      throw new Error('Chat session not found');
    }
    
    return session;
  }

  async sendMessage(args: { personaId: string, chatSessionId?: string, message: string }): Promise<any> {
    const { personaId, chatSessionId, message } = args;
    const { user } = this.context;
    
    try {
      // Get the persona's provider
      const persona = await this.context.getService("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.provider || "openai";
      
      // Get provider adapter
      const adapter = await this.providerService.getAdapter(provider);
      
      let response;
      if (provider === "openai") {
        // Use OpenAI service for OpenAI provider
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message
        });
      } else {
        throw new Error(`Provider ${provider} not implemented`);
      }
      
      // Save message to conversation history
      let conversation;
      if (chatSessionId) {
        conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();
      }
      
      if (!conversation) {
        // Create new conversation
        conversation = new ReactorConversationModel({
          personaId,
          user,
          started: new Date(),
          history: []
        });
      }
      
      // Add user message
      conversation.history.push({
        role: "user",
        content: message,
        timestamp: new Date()
      });
      
      // Add AI response if available
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
      
      // Return adapted response
      return adapter.adaptResponse(response);
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

  async executeMacro(args: { macro: string, personaId: string, chatSessionId: string }): Promise<any> {
    const { macro, personaId, chatSessionId } = args;
    
    try {
      // Get the persona's provider
      const persona = await this.context.getService("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.provider || "openai";
      
      // Get provider adapter
      const adapter = await this.providerService.getAdapter(provider);
      
      let response;
      if (provider === "openai") {
        // Execute macro using OpenAI service
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message: `[EXECUTE MACRO: ${macro}]` // Special syntax to indicate macro execution
        });
      } else {
        throw new Error(`Provider ${provider} not implemented`);
      }
      
      // Update conversation
      const conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();
      if (!conversation) {
        throw new Error('Conversation not found');
      }
      
      // Add macro execution record
      conversation.history.push({
        role: "system",
        content: `Executed macro: ${macro}`,
        timestamp: new Date()
      });
      
      // Add AI response if available
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
      
      // Return adapted response
      return adapter.adaptResponse(response);
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

  async executeTool(args: { tool: string, personaId: string, chatSessionId: string }): Promise<any> {
    const { tool, personaId, chatSessionId } = args;
    
    try {
      // Similar implementation to executeMacro but for tools
      const persona = await this.context.getService("reactor.AIPersonaProvider@1.0.0").getPersona(personaId);
      const provider = persona.provider || "openai";
      const adapter = await this.providerService.getAdapter(provider);
      
      let response;
      if (provider === "openai") {
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message: `[EXECUTE TOOL: ${tool}]` // Special syntax to indicate tool execution
        });
      } else {
        throw new Error(`Provider ${provider} not implemented`);
      }
      
      // Update conversation with tool execution
      const conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();
      if (!conversation) {
        throw new Error('Conversation not found');
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

  toString?(includeVersion?: boolean): string {
    return `ReactorConversationService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string = "Service for managing reactor chat conversations";
  tags?: string[] = ["ai", "chat", "conversations"];
  nameSpace: string = "reactor";
  name: string = "Reactor Conversation Service";
  version: string = "1.0.0";
}