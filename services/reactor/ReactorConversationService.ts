import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import {
  IReactorConversationsService,
  IOpenAIService,
  IReactorProviderService,
  IAIPersona,
  IAIProviderService,
  KnownAIProviders,
} from "../../types/service.types";
import ReactorConversationModel, {
  ReactorConversationDocument,
  TReactorConversationDocument,
  TReactorConversationModel,
  ValidProviderResponseTypes,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import AIPersonaProvider from "./AIPersonaProvider";
import ReactorMessageProcessingService from "./ReactorMessageProcessingService";
import { v4 } from "uuid";
import { ObjectId } from "mongodb";
import OpenAI from "openai";
import {
  MacroComponentDefinition,
  MacroToolDefinition,
  ToolApprovalMode,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
// import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/openai/chat/macro";
import GoogleAIService from "./providers/GoogleAIService";
import { ChatCompletion, ChatCompletionMessage } from "openai/resources";
import ReactorMacroService from "./providers/ReactorMacroService";
import DocumentChunkingService from "./DocumentChunkingService";
import { ReactorConversationHistoryItem } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import { ReactoryFileDocument, ReactoryFileModel } from "modules/reactory-core/models/CoreFile";
import { id } from "schema/reflection";

@service({
  id: "reactor.ReactorConversationService@1.0.0",
  name: "ReactorConversationService",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for managing reactor chat conversations",
  serviceType: "ai",
  dependencies: [
    { id: "core.FileService@1.0.0", alias: "fileService" },
    { id: "reactor.OpenAIService@1.0.0", alias: "openaiService" },
    { id: "reactor.GoogleAIService@1.0.0", alias: "googleAIService" },
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" },
    {
      id: "reactor.ReactorMessageProcessingService@1.0.0",
      alias: "messageProcessingService",
    },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
    { id: "reactor.DocumentChunkingService@1.0.0", alias: "chunkingService" },
  ],
})
export default class ReactorConversationService
  implements IReactorConversationsService
{
  private context: Reactory.Server.IReactoryContext;
  private openaiService: IOpenAIService;
  private googleAIService: GoogleAIService;
  private providerService: IReactorProviderService;
  private personaProvider: AIPersonaProvider;
  private messageProcessingService: ReactorMessageProcessingService;
  private macroService: ReactorMacroService;
  private chunkingService: DocumentChunkingService;
  private fileService: Reactory.Service.IReactoryFileService;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.context = context;
    this.chunkingService = (props.dependencies as any)
      ?.chunkingService as DocumentChunkingService;
  }

  /**
   * Validate conversation document for common issues
   */
  private validateConversationDocument(
    conversation: any,
    operation: string,
    context: string = ""
  ): void {
    if (!conversation) {
      this.context.error(
        `Conversation document is null/undefined during ${operation}`,
        {
          operation,
          context,
          user: this.context.user?._id,
          timestamp: new Date().toISOString(),
        }
      );
      return;
    }

    const issues: string[] = [];
    const metadata: any = {
      operation,
      context,
      timestamp: new Date().toISOString(),
      user: this.context.user?._id,
    };

    // Check for null/undefined IDs
    if (!conversation._id) {
      issues.push("Missing _id field");
      metadata.missingId = true;
      // Add specific logging for null _id cases
      this.context.error("CRITICAL: Conversation document has null _id", {
        operation,
        context,
        conversationKeys: Object.keys(conversation),
        conversationType: typeof conversation,
        isDocument: conversation instanceof Object,
        hasId: !!conversation.id,
        idValue: conversation.id,
        timestamp: new Date().toISOString(),
      });
    } else {
      metadata.conversationId = conversation._id.toString();
    }

    if (!conversation.id) {
      issues.push("Missing id field");
      metadata.missingIdField = true;
    } else {
      metadata.conversationIdField = conversation.id.toString();
    }

    // Check for user assignment
    if (!conversation.user) {
      issues.push("Missing user assignment");
      metadata.missingUser = true;
    } else {
      metadata.conversationUser = conversation.user.toString();
    }

    // Check for required fields
    if (!conversation.personaId) {
      issues.push("Missing personaId");
      metadata.missingPersonaId = true;
    }

    if (!conversation.started) {
      issues.push("Missing started timestamp");
      metadata.missingStarted = true;
    }

    // Log issues if any found
    if (issues.length > 0) {
      this.context.error(`Conversation validation failed during ${operation}`, {
        ...metadata,
        issues,
        conversationKeys: Object.keys(conversation),
        conversationType: typeof conversation,
        isDocument: conversation instanceof Object,
      });
    } else {
      this.context.debug(
        `Conversation validation passed during ${operation}`,
        metadata
      );
    }
  }

  /**
   * Calculate and update the token count for a conversation
   */
  private async updateConversationTokenCount(
    conversationId: string
  ): Promise<number> {
    this.context.debug("Updating conversation token count", {
      conversationId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: conversationId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error("Conversation not found during token count update", {
        conversationId,
        userId: this.context.user?._id,
      });
      throw new Error("Conversation not found");
    }

    // Validate the conversation before updating token count
    this.validateConversationDocument(
      conversation,
      "updateConversationTokenCount",
      "before_update"
    );

    // Calculate total token count from conversation history
    let totalTokens = 0;
    conversation.history.forEach((message) => {
      if (message.content && typeof message.content === "string") {
        // Use the chunking service's token estimation method
        totalTokens += this.chunkingService.estimateTokenCount(message.content);
      }
    });

    // Update the conversation with the new token count
    await ReactorConversationModel.findOneAndUpdate(
      { _id: conversationId },
      {
        tokenCount: totalTokens,
        updated: new Date(),
      },
      { new: true }
    ).exec();

    return totalTokens;
  }

  /**
   * Check if conversation exceeds max tokens and handle accordingly
   */
  private async checkTokenLimit(conversationId: string): Promise<{
    exceedsLimit: boolean;
    currentTokens: number;
    maxTokens: number;
    shouldTruncate: boolean;
  }> {
    this.context.debug("Checking token limit", {
      conversationId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: conversationId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error("Conversation not found during token limit check", {
        conversationId,
        userId: this.context.user?._id,
      });
      throw new Error("Conversation not found");
    }

    // Validate the conversation before checking token limits
    this.validateConversationDocument(
      conversation,
      "checkTokenLimit",
      "before_check"
    );

    const currentTokens = conversation.tokenCount || 0;
    const maxTokens = conversation.maxTokens;

    if (!maxTokens) {
      return {
        exceedsLimit: false,
        currentTokens,
        maxTokens: 0,
        shouldTruncate: false,
      };
    }

    const exceedsLimit = currentTokens > maxTokens;
    const shouldTruncate = exceedsLimit && currentTokens > maxTokens * 1.2; // Truncate if 20% over limit

    return {
      exceedsLimit,
      currentTokens,
      maxTokens,
      shouldTruncate,
    };
  }

  /**
   * Truncate conversation history to stay within token limits
   * This method removes older messages while preserving system messages and recent context
   * Removed messages are stored in truncatedHistory for analysis
   */
  private async truncateConversationHistory(
    conversationId: string,
    targetTokens: number
  ): Promise<{
    removedMessages: number;
    remainingTokens: number;
    movedToTruncated: number;
  }> {
    this.context.debug("Truncating conversation history", {
      conversationId,
      targetTokens,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: conversationId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error("Conversation not found during history truncation", {
        conversationId,
        userId: this.context.user?._id,
      });
      throw new Error("Conversation not found");
    }

    // Validate the conversation before truncation
    this.validateConversationDocument(
      conversation,
      "truncateConversationHistory",
      "before_truncation"
    );

    const history = [...conversation.history];
    const existingTruncatedHistory = conversation.truncatedHistory || [];
    let currentTokens = conversation.tokenCount || 0;
    let removedMessages = 0;
    let movedToTruncated = 0;

    // Keep system messages and recent messages, remove older user/assistant messages
    const systemMessages = history.filter((msg) => msg.role === "system");
    const nonSystemMessages = history.filter((msg) => msg.role !== "system");

    // Calculate tokens for system messages
    let systemTokens = 0;
    systemMessages.forEach((msg) => {
      if (msg.content && typeof msg.content === "string") {
        systemTokens += this.chunkingService.estimateTokenCount(msg.content);
      }
    });

    // If system messages alone exceed the limit, we have a problem
    if (systemTokens > targetTokens) {
      this.context.warn(
        `System messages exceed token limit for conversation ${conversationId}`,
        { systemTokens, targetTokens }
      );
      return {
        removedMessages: 0,
        remainingTokens: systemTokens,
        movedToTruncated: 0,
      };
    }

    // Remove messages from the beginning (oldest) until we're under the limit
    const messagesToKeep = [];
    const messagesToMove = [];
    let tokensUsed = systemTokens;

    // Add system messages first
    messagesToKeep.push(...systemMessages);

    // Add recent messages, working backwards
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const message = nonSystemMessages[i];
      const messageTokens =
        message.content && typeof message.content === "string"
          ? this.chunkingService.estimateTokenCount(message.content)
          : 0;

      if (tokensUsed + messageTokens <= targetTokens) {
        messagesToKeep.unshift(message); // Add to beginning to maintain order
        tokensUsed += messageTokens;
      } else {
        // Move message to truncated history instead of discarding
        messagesToMove.unshift(message);
        removedMessages++;
        movedToTruncated++;
      }
    }

    // Combine existing truncated history with new messages to move
    const updatedTruncatedHistory = [
      ...existingTruncatedHistory,
      ...messagesToMove,
    ];

    // Update the conversation with truncated history and moved messages
    await ReactorConversationModel.findOneAndUpdate(
      { _id: conversationId },
      {
        history: messagesToKeep,
        truncatedHistory: updatedTruncatedHistory,
        tokenCount: tokensUsed,
        updated: new Date(),
      },
      { new: true }
    ).exec();

    this.context.info(`Truncated conversation ${conversationId}`, {
      originalTokens: currentTokens,
      remainingTokens: tokensUsed,
      removedMessages,
      movedToTruncated,
      totalTruncatedMessages: updatedTruncatedHistory.length,
      targetTokens,
    });

    return {
      removedMessages,
      remainingTokens: tokensUsed,
      movedToTruncated,
    };
  }

  /**
   * Get the full conversation history including truncated messages for analysis
   * This combines the active history with truncated history in chronological order
   */
  async getFullConversationHistory(chatSessionId: string): Promise<{
    fullHistory: ReactorConversationHistoryItem[];
    activeHistory: ReactorConversationHistoryItem[];
    truncatedHistory: ReactorConversationHistoryItem[];
    statistics: {
      totalMessages: number;
      activeMessages: number;
      truncatedMessages: number;
      totalTokens: number;
      activeTokens: number;
      truncatedTokens: number;
    };
  }> {
    this.context.debug("Getting full conversation history", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error(
        "Conversation not found during getFullConversationHistory",
        {
          chatSessionId,
          userId: this.context.user?._id,
        }
      );
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before retrieving full history
    this.validateConversationDocument(
      conversation,
      "getFullConversationHistory",
      "before_retrieval"
    );

    const activeHistory = conversation.history || [];
    const truncatedHistory = conversation.truncatedHistory || [];

    // Combine histories in chronological order based on timestamp
    const allMessages = [...activeHistory, ...truncatedHistory];
    const sortedHistory = allMessages.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    // Calculate token statistics
    const calculateTokens = (
      messages: ReactorConversationHistoryItem[]
    ): number => {
      return messages.reduce((total, msg) => {
        if (msg.content && typeof msg.content === "string") {
          return total + this.chunkingService.estimateTokenCount(msg.content);
        }
        return total;
      }, 0);
    };

    const activeTokens = calculateTokens(activeHistory);
    const truncatedTokens = calculateTokens(truncatedHistory);
    const totalTokens = activeTokens + truncatedTokens;

    return {
      fullHistory: sortedHistory,
      activeHistory,
      truncatedHistory,
      statistics: {
        totalMessages: allMessages.length,
        activeMessages: activeHistory.length,
        truncatedMessages: truncatedHistory.length,
        totalTokens,
        activeTokens,
        truncatedTokens,
      },
    };
  }

  /**
   * Clear the truncated history for a conversation
   * This can be used for cleanup or when you want to free up storage
   */
  async clearTruncatedHistory(chatSessionId: string): Promise<{
    clearedMessages: number;
    clearedTokens: number;
  }> {
    this.context.debug("Clearing truncated history", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error(
        "Conversation not found during clearTruncatedHistory",
        {
          chatSessionId,
          userId: this.context.user?._id,
        }
      );
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before clearing truncated history
    this.validateConversationDocument(
      conversation,
      "clearTruncatedHistory",
      "before_clear"
    );

    const truncatedHistory = conversation.truncatedHistory || [];
    const clearedTokens = truncatedHistory.reduce((total, msg) => {
      if (msg.content && typeof msg.content === "string") {
        return total + this.chunkingService.estimateTokenCount(msg.content);
      }
      return total;
    }, 0);

    await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId },
      {
        truncatedHistory: [],
        updated: new Date(),
      },
      { new: true }
    ).exec();

    this.context.info(
      `Cleared truncated history for conversation ${chatSessionId}`,
      {
        clearedMessages: truncatedHistory.length,
        clearedTokens,
      }
    );

    return {
      clearedMessages: truncatedHistory.length,
      clearedTokens,
    };
  }

  async setChatToolApprovalMode(
    chatSessionId: string,
    toolApprovalMode: ToolApprovalMode
  ): Promise<any> {
    // load the chat session
    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { toolApprovalMode },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    return chatState;
  }

  async setChatMaxTokens(
    chatSessionId: string,
    maxTokens: number
  ): Promise<any> {
    this.context.debug("Setting chat max tokens", {
      chatSessionId,
      maxTokens,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    // Validate max tokens
    if (maxTokens <= 0) {
      this.context.error("Invalid max tokens value", {
        chatSessionId,
        maxTokens,
        userId: this.context.user?._id,
      });
      throw new Error("Max tokens must be greater than 0");
    }

    // load the chat session
    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { maxTokens },
      { new: true }
    ).exec();

    if (!chatState) {
      this.context.error("Chat session not found during setChatMaxTokens", {
        chatSessionId,
        maxTokens,
        userId: this.context.user?._id,
      });
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    // Validate the updated conversation
    this.validateConversationDocument(
      chatState,
      "setChatMaxTokens",
      "after_update"
    );

    // Check if current conversation exceeds the new limit
    const tokenCheck = await this.checkTokenLimit(chatSessionId);
    if (tokenCheck.exceedsLimit) {
      this.context.warn(
        `Conversation ${chatSessionId} exceeds new max token limit`,
        {
          currentTokens: tokenCheck.currentTokens,
          maxTokens: tokenCheck.maxTokens,
          exceedsBy: tokenCheck.currentTokens - tokenCheck.maxTokens,
        }
      );
    }

    return chatState;
  }

  async getChatTokenCount(chatSessionId: string): Promise<{
    currentTokens: number;
    maxTokens: number | null;
    exceedsLimit: boolean;
    percentageUsed: number;
  }> {
    this.context.debug("Getting chat token count", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error("Conversation not found during getChatTokenCount", {
        chatSessionId,
        userId: this.context.user?._id,
      });
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before getting token count
    this.validateConversationDocument(
      conversation,
      "getChatTokenCount",
      "before_count"
    );

    const currentTokens = conversation.tokenCount || 0;
    const maxTokens = conversation.maxTokens;
    const exceedsLimit = maxTokens ? currentTokens > maxTokens : false;
    const percentageUsed = maxTokens ? (currentTokens / maxTokens) * 100 : 0;

    return {
      currentTokens,
      maxTokens,
      exceedsLimit,
      percentageUsed,
    };
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

  async getConversations(filter: any): Promise<TReactorConversationDocument[]> {
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

    return ReactorConversationModel.find(query).populate("user").exec();
  }

  async getChatSession(args: { id: string }): Promise<
    TReactorConversationDocument & {
      context?: Reactory.Server.IReactoryContext;
    }
  > {
    const { id } = args;
    const session: any = await ReactorConversationModel.findOne({
      _id: id,
    })
      .populate("user")
      .exec();

    if (!session) {
      throw new Error("Chat session not found");
    }

    session.id = session._id.toString();
    session.context = this.context;

    return session;
  }

  // Create a new conversation
  private async getNewConversation(
    persona: IAIPersona
  ): Promise<TReactorConversationDocument> {
    this.context.debug("Creating new conversation", {
      personaId: persona?.id,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    // Check if the persona is valid
    if (!persona || !persona.id) {
      this.context.error("Invalid persona provided for new conversation", {
        persona: persona,
        personaId: persona?.id,
        userId: this.context.user?._id,
      });
      throw new Error("Invalid persona");
    }

    // Check if the user is valid
    if (!this.context.user) {
      this.context.error("No user context found for new conversation", {
        personaId: persona.id,
      });
      throw new Error("User not found");
    }

    // before we create we check if the last conversionation with this persona is empty
    // if it is empty we return the last conversation
    const lastConversation = await ReactorConversationModel.findOne({
      personaId: persona.id,
      user: this.context.user,
    })

      .sort({ started: -1 })
      .populate("user")
      .exec();
    if (
      lastConversation &&
      lastConversation.history.length === 1 &&
      lastConversation.history[0].role === "system"
    ) {
      if (!lastConversation.id) {
        lastConversation.id = lastConversation._id.toString();        
      }
      if (!lastConversation.sseSessionId) {
        lastConversation.sseSessionId = lastConversation._id.toString();
      }
      lastConversation.started = new Date();
      await lastConversation.save();
      
      return lastConversation;
    }
  
    const conversationData: any = {
      personaId: persona.id,
      user: this.context.user,
      modelId: persona.modelId,
      providerId: persona.providerId,
      history: [],
      vars: {},
      meta: {
        summary: "Reactor Chat Session with agent " + persona.name,
        title: "Chat with " + persona.name,
      },
      macros: [],
      tools: [],
      started: new Date(),
      toolApprovalMode: ToolApprovalMode.PROMPT,
      tokenCount: 0,
      maxTokens: persona.maxTokens || 8000, // Default to 8k tokens if not specified
    };

    try {
      const conversation = new ReactorConversationModel(
        conversationData
      ) as unknown as TReactorConversationDocument;

      this.context.debug("Saving new conversation", {
        personaId: conversation.personaId,
        userId: conversation.user?.toString(),
        timestamp: new Date().toISOString(),
      });

      await conversation.save();

      const sessionId = conversation._id.toString();
      conversation.sseSessionId = sessionId;
      conversation.id = sessionId;
      await conversation.save();

      // Validate the saved conversation
      this.validateConversationDocument(
        conversation,
        "getNewConversation",
        "after_save"
      );

      // update the sessionId and sseSessionId to the conversation
      conversation.sseSessionId = conversation._id.toString();
      conversation.id = conversation._id.toString();
      await conversation.save();

      this.context.info("Successfully created new conversation", {
        conversationId: conversation._id?.toString(),
        sessionId: conversation.id,
        personaId: conversation.personaId,
        userId: conversation.user?.toString(),
        tokenCount: conversation.tokenCount,
        maxTokens: conversation.maxTokens,
      });

      return conversation;
    } catch (error: any) {
      // Handle duplicate key errors gracefully
      if (error.code === 11000) {
        this.context.warn(
          "Duplicate conversation detected, attempting to find existing conversation",
          {
            personaId: persona.id,
            userId: this.context.user._id,
            error: error.message,
          }
        );

        // Try to find the existing conversation that was just created
        const existingConversation = await ReactorConversationModel.findOne({
          personaId: persona.id,
          user: this.context.user,
          started: conversationData.started,
        })
          .populate("user")
          .exec();

        if (existingConversation) {
          return existingConversation;
        }
      }

      // Re-throw the error if it's not a duplicate key error or if we can't find the existing conversation
      throw error;
    }
  }

  async sendMessage(args: {
    personaId: string;
    chatSessionId?: string;
    message: string | any;
    role?: string;
    tool_name?: string;
    tool_args?: any;
    tool_call_id?: string;
  }): Promise<any> {
    const {
      personaId,
      chatSessionId,
      message,
      // the message could be user or tool.
      role = "user",
      tool_name,
      tool_args,
      tool_call_id,
    } = args;
    const { user } = this.context;

    this.context.debug("Sending message", {
      personaId,
      chatSessionId,
      messageLength: typeof message === "string" ? message.length : "object",
      role,
      userId: user?._id,
      timestamp: new Date().toISOString(),
    });

    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get the persona's provider
        const persona = await this.context
          .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0", {
            chatSessionId,
          })
          .getPersona(personaId);
        const provider = persona.providerId || "xai";

        // Save message to conversation history
        let conversation;
        if (chatSessionId) {
          this.context.debug("Finding existing conversation", {
            chatSessionId,
            userId: this.context.user?._id,
            timestamp: new Date().toISOString(),
          });

          // Use findOneAndUpdate to atomically find and update the conversation
          // This prevents race conditions that could lead to duplicate creation
          conversation = await ReactorConversationModel.findOneAndUpdate(
            { _id: chatSessionId, user: this.context.user },
            {
              $push: {
                history: {
                  id: new ObjectId(),
                  role: role as any,
                  content: message,
                  timestamp: new Date(),
                  tool_name,
                  tool_args,
                  tool_call_id,
                },
              },
              $set: { updated: new Date() },
            },
            { new: true, upsert: false }
          )
            .populate("user")
            .exec();

          // Validate the found/updated conversation
          this.validateConversationDocument(
            conversation,
            "sendMessage",
            "existing_conversation"
          );

          // Update token count after adding user message
          await this.updateConversationTokenCount(conversation._id.toString());

          // Check token limits and truncate if necessary
          const tokenCheck = await this.checkTokenLimit(
            conversation._id.toString()
          );
          if (tokenCheck.shouldTruncate) {
            await this.truncateConversationHistory(
              conversation._id.toString(),
              tokenCheck.maxTokens * 0.8 // Keep at 80% of limit
            );
          }

          if (!conversation) {
            throw new Error(
              `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
            );
          }
        } else {
          // Create new conversation only when no chatSessionId is provided
          const sessionId = new ObjectId();
          conversation = new ReactorConversationModel({
            id: sessionId,
            personaId,
            user,
            modelId: persona.modelId,
            providerId: provider,
            history: [
              {
                id: new ObjectId(),
                role: role as any,
                content: message,
                timestamp: new Date(),
                tool_name,
                tool_args,
                tool_call_id,
              },
            ],
            vars: {},
            meta: {
              summary: "Reactor Chat Session with agent " + persona.name,
              title: "Chat with " + persona.name,
            },
            macros: persona.macros || [],
            tools: persona.tools || [],
            started: new Date(),
            sseSessionId: sessionId,
            toolApprovalMode: ToolApprovalMode.PROMPT,
          });

          this.context.debug("Saving new conversation in sendMessage", {
            sessionId: sessionId.toString(),
            personaId: conversation.personaId,
            userId: conversation.user?.toString(),
            timestamp: new Date().toISOString(),
          });

          await conversation.save();

          // Validate the newly created conversation
          this.validateConversationDocument(
            conversation,
            "sendMessage",
            "new_conversation"
          );

          // Update token count for new conversation
          await this.updateConversationTokenCount(conversation._id.toString());
        }

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
              message,
              role: role as any,
              tool_name,
              tool_args,
              tool_call_id,
            });

            // Add AI response if available
            if (response?.choices && response?.choices?.length > 0) {
              const aiMessage = response.choices[0].message;
              // Use findOneAndUpdate for atomic update
              await ReactorConversationModel.findOneAndUpdate(
                { _id: conversation._id },
                {
                  $push: {
                    history: {
                      id: new ObjectId(),
                      response, // add the original response for debugging
                      role: aiMessage.role,
                      content: aiMessage.content,
                      timestamp: new Date(),
                      tool_calls: aiMessage.tool_calls,
                      tool_results: [],
                    },
                  },
                  $set: { updated: new Date() },
                },
                { new: true }
              ).exec();

              // Update token count after adding AI response
              await this.updateConversationTokenCount(
                conversation._id.toString()
              );
            } else {
              this.context.warn(
                `No AI response received for message: ${message}`,
                { response }
              );
              await ReactorConversationModel.findOneAndUpdate(
                { _id: conversation._id },
                {
                  $push: {
                    history: {
                      id: new ObjectId(),
                      role: "system",
                      content: "No AI response received",
                      timestamp: new Date(),
                      tool_results: [],
                    },
                  },
                  $set: { updated: new Date() },
                },
                { new: true }
              ).exec();

              // Update token count after adding system message
              await this.updateConversationTokenCount(
                conversation._id.toString()
              );
            }
            // Add session ID to response
            // @ts-ignore
            response.sessionId = conversation._id.toString();

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
              message,
              role: role as any,
              tool_name,
              tool_args,
              tool_call_id,
              persistState: false, // Don't persist here since we handle it in ReactorConversationService
            });

            // Add AI response if available
            if (response?.choices && response?.choices?.length > 0) {
              const aiMessage = response.choices[0].message;
              await ReactorConversationModel.findOneAndUpdate(
                { _id: conversation._id },
                {
                  $push: {
                    history: {
                      id: new ObjectId(),
                      response, // add the original response for debugging
                      role: aiMessage.role,
                      content: aiMessage.content,
                      timestamp: new Date(),
                      tool_calls: aiMessage.tool_calls,
                      tool_results: [],
                    },
                  },
                  $set: { updated: new Date() },
                },
                { new: true }
              ).exec();

              // Update token count after adding AI response
              await this.updateConversationTokenCount(
                conversation._id.toString()
              );
            } else {
              this.context.warn(
                `No AI response received for message: ${message}`,
                { response }
              );
              await ReactorConversationModel.findOneAndUpdate(
                { _id: conversation._id },
                {
                  $push: {
                    history: {
                      id: new ObjectId(),
                      role: "system",
                      content: "No AI response received",
                      timestamp: new Date(),
                      tool_results: [],
                    },
                  },
                  $set: { updated: new Date() },
                },
                { new: true }
              ).exec();

              // Update token count after adding system message
              await this.updateConversationTokenCount(
                conversation._id.toString()
              );
            }
            // Add session ID to response
            // @ts-ignore
            response.sessionId = conversation._id.toString();

            return adapter.adaptResponse(response);

          default: {
            this.context.error(`Provider ${provider} not implemented`, {
              provider,
            });
            throw new Error(`Provider ${provider} not implemented`);
          }
        }
        // Check if the response is actually an error response
        if (this.isErrorResponse(response)) {
          throw new Error(
            `AI provider returned error response: ${
              response.choices?.[0]?.message?.content || "Unknown error"
            }`
          );
        }

        // If we get here, the attempt was successful
        return response;
      } catch (error: any) {
        lastError = error;

        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(error);

        this.context.warn(
          `SendMessage attempt ${attempt} failed: ${error.message}`,
          {
            error: error.message,
            attempt,
            maxRetries,
            isRetryable,
            personaId,
            chatSessionId,
          }
        );

        if (attempt < maxRetries && isRetryable) {
          // Wait before retry with exponential backoff
          const backoffDelay = Math.pow(2, attempt) * 1000;
          this.context.log(
            `Waiting ${backoffDelay}ms before retry attempt ${attempt + 1}`,
            { backoffDelay, attempt }
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        // If not retryable or max retries reached, break and throw
        break;
      }
    }

    // If we get here, all retries failed
    this.context.error(
      `Error sending message after ${maxRetries} attempts: ${
        lastError?.message ?? lastError?.toString()
      }`,
      { error: lastError, args }
    );

    return {
      __typename: "ReactorErrorResponse",
      code: "MESSAGE_ERROR",
      message:
        lastError?.message || "Error sending message after multiple attempts",
      details: lastError,
      timestamp: new Date(),
      recoverable: true,
      suggestion: "Please try again or check your connection",
    };
  }

  async executeMacro(args: {
    macro: string;
    personaId: string;
    chatSessionId: string;
    calledBy?: string;
    callId?: string;
    args?: any;
  }): Promise<any> {
    const {
      macro,
      personaId,
      chatSessionId,
      calledBy = "assistant",
      callId = v4(),
    } = args;

    try {
      // Get the persona's provider
      const persona = await this.context
        .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
        .getPersona(personaId);
      const provider = persona.providerId || "openai";

      // Get provider adapter
      const adapter = await this.providerService.getAdapter(provider);

      // Get conversation without modifying it
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error("Conversation not found");
      }

      // @ts-ignore
      conversation.context = this.context;

      // check if the macro is available on the chat session
      let macroDef = conversation.macros.find((m) => m.name === macro);
      if (macroDef === undefined || macroDef === null) {
        // check using the alias
        macroDef ??= (conversation as TReactorConversationDocument).macros.find(
          (m: { alias: string }) => m.alias === macro
        );

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
          throw new Error(
            `User does not have permission to execute macro ${macro}`
          );
        }
      }

      // Execute the macro
      const macroFunction = this.macroService.getMacro(macroDef.name);
      if (!macroFunction) {
        throw new Error(`Macro ${macro} not found in macro registry`);
      }
      // @ts-ignore
      let result: any = await macroFunction(
        args.args,
        conversation as any,
        this.context
      );
      if (!result) {
        throw new Error(`Macro ${macro} returned no result`);
      }

      // we need to calculate token count of the result, and add it to the conversation
      let resultString = JSON.stringify(result);
      const tokenCount = await this.chunkingService.estimateTokenCount(
        resultString
      );

      if (tokenCount > conversation.maxTokens) {
        throw new Error(
          `Macro ${macro} result is too large. Max tokens: ${conversation.maxTokens}, Token count: ${tokenCount}`
        );
      }

      if (tokenCount + conversation.tokenCount > conversation.maxTokens) {
        // create a copy of the original history, in the event that
        // the truncation is not enough to fit the result.
        // first check what size the new history would be if we truncate it.
        throw new Error(
          `Macro ${macro} result is too large. Max tokens: ${
            conversation.maxTokens
          }, Token count: ${tokenCount + conversation.tokenCount}`
        );
      }

      const toolResult = {
        __typename: "ReactorChatMessage",
        role: "tool",
        content: `Tool ${macro} (${
          callId || "no call id"
        }) executed successfully.`,
        tool_results: [
          {
            id: callId,
            name: macro,
            result: result,
          },
        ],
        tool_call_id: callId,
        tool_name: macro,
        tool_args: args.args,
        id: new ObjectId(),
        timestamp: new Date(),
      };

      // Use atomic update to add macro result to conversation history
      await ReactorConversationModel.findOneAndUpdate(
        { _id: chatSessionId },
        {
          $push: { history: toolResult },
          $set: { updated: new Date() },
        },
        { new: true }
      ).exec();

      return adapter.adaptResponse(toolResult);
    } catch (error) {
      this.context.error(`Error executing macro: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "MACRO_ERROR",
        message: error.message || "Error executing macro",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Check if the macro exists and you have permission to execute it",
      };
    }
  }

  async executeTool(args: {
    tool: string;
    toolArgs?: any;
    personaId: string;
    chatSessionId: string;
  }): Promise<any> {
    const { tool, personaId, chatSessionId } = args;

    return this.executeMacro({
      macro: tool,
      personaId,
      chatSessionId,
      args: args.toolArgs,
    });
  }

  async attachImage(args: {
    image: string;
    personaId: string;
    chatSessionId: string;
  }): Promise<any> {
    const { image, personaId, chatSessionId } = args;

    try {
      const persona = await this.context
        .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
        .getPersona(personaId);
      const provider = persona.providerId || "openai";
      const adapter = await this.providerService.getAdapter(provider);

      // Validate conversation exists and user has access
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      // Use atomic update to add image message to history
      await ReactorConversationModel.findOneAndUpdate(
        { _id: chatSessionId },
        {
          $push: {
            history: {
              id: new ObjectId(),
              role: "user",
              content: "[Image attached]",
              timestamp: new Date(),
              // @ts-ignore
              imageData: image,
            },
          },
          $set: { updated: new Date() },
        },
        { new: true }
      ).exec();

      // Process image with AI if supported
      let response;
      if (provider === "openai" && persona.modelId === "gpt-4-vision-preview") {
        // @ts-ignore
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message: "What do you see in this image?",
          image: image,
        });

        if (response.choices && response.choices.length > 0) {
          const aiMessage = response.choices[0].message;
          // Use atomic update to add AI response
          await ReactorConversationModel.findOneAndUpdate(
            { _id: chatSessionId },
            {
              $push: {
                history: {
                  id: new ObjectId(),
                  role: aiMessage.role,
                  content: aiMessage.content,
                  timestamp: new Date(),
                  tool_calls: aiMessage.tool_calls,
                },
              },
              $set: { updated: new Date() },
            },
            { new: true }
          ).exec();
        }
      }

      if (response) {
        return adapter.adaptResponse(response);
      } else {
        return {
          __typename: "ReactorChatMessage",
          id: Math.random().toString(36).substring(2, 15),
          role: "system",
          content: "Image attached successfully",
          timestamp: new Date(),
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
        suggestion: "Check image format and size",
      };
    }
  }

  async attachFiles(args: {
    files: ReactoryFileDocument[];    
    chatSessionId: string;
  }): Promise<any> {
    const { files, chatSessionId } = args;

    try {
     
      // Validate conversation exists and user has access
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }      

      const fileResult = {
        id: new ObjectId(),
        role: "tool",
        name: "attachFiles",
        content: `Files attached successfully.`,
        tool_results: files.map((file) => ({
          id: file._id,
          name: file.name,  
          size: file.size,
          mimeType: file.mimeType,
          url: file.url,
        })),
        tool_call_id: v4(),
        tool_name: "attachFiles", 
        tool_args: args,
        timestamp: new Date(),
      };

      conversation.history.push(fileResult);
      await conversation.save();

      return {
        __typename: "ReactorChatMessage",
        sessionId: chatSessionId,
        ...fileResult,
      };
    } catch (error) {
      this.context.error(`Error attaching files: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "FILE_ERROR",
        message: error.message || "Error attaching files",
        details: error,
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Check file formats and sizes",
      };
    }
  }

  async deleteChatSession(args: { id: string }): Promise<boolean> {
    const { id } = args;

    try {
      const result = await ReactorConversationModel.deleteOne({
        _id: id,
        user: this.context.user,
      }).exec();
      return result.deletedCount > 0;
    } catch (error) {
      this.context.error(`Error deleting chat session: ${error.message}`, {
        error,
      });
      return false;
    }
  }

  async loadChatSession(
    chatSessionId: string
  ): Promise<TReactorConversationDocument | null> {
    this.context.debug("Loading chat session", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    if (!chatSessionId) {
      this.context.error("Chat session ID is required for loadChatSession", {
        userId: this.context.user?._id,
      });
      throw new Error("Chat session ID is required");
    }

    // Load the chat session by ID
    const chatSession = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!chatSession) {
      this.context.error("Chat session not found during loadChatSession", {
        chatSessionId,
        userId: this.context.user?._id,
      });
      throw new Error(
        `Chat session with ID ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the loaded conversation
    this.validateConversationDocument(
      chatSession,
      "loadChatSession",
      "loaded_session"
    );

    chatSession.id = chatSession._id.toString();

    this.context.info("Successfully loaded chat session", {
      chatSessionId: chatSession._id?.toString(),
      personaId: chatSession.personaId,
      userId: chatSession.user?.toString(),
      historyLength: chatSession.history?.length || 0,
      tokenCount: chatSession.tokenCount,
      maxTokens: chatSession.maxTokens,
    });

    return chatSession;
  }

  async startChatSession(args: {
    personaId: string;
    macros: Partial<MacroComponentDefinition<unknown>>[];
    tools: Partial<MacroToolDefinition>[];
  }): Promise<TReactorConversationDocument> {
    this.context.debug("Starting chat session", {
      personaId: args.personaId,
      userId: this.context.user?._id,
      macrosCount: args.macros?.length || 0,
      toolsCount: args.tools?.length || 0,
      timestamp: new Date().toISOString(),
    });

    const persona = await this.personaProvider.getPersona(args.personaId);
    if (!persona) {
      this.context.error("Persona not found during startChatSession", {
        personaId: args.personaId,
        userId: this.context.user?._id,
      });
      throw new Error(`Persona with id ${args.personaId} not found`);
    }

    const conversation = await this.getNewConversation(persona);
    if (!conversation || !conversation.id || !conversation._id) {
      this.context.error(
        "Failed to create new conversation in startChatSession",
        {
          personaId: args.personaId,
          userId: this.context.user?._id,
          conversation: conversation,
        }
      );
      throw new Error("Failed to create new conversation");
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
          alias: macro.alias,
        });
      });
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
      });
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
      const promptText = this.context.utils.lodash.template(
        systemPromptTemplate.content
      )({
        user: {
          _id: this.context.user._id,
          name: this.context.user.firstName + " " + this.context.user.lastName,
          email: this.context.user.email,
          avatar: this.context.user.avatar,
          createdAt: this.context.user.createdAt,
        },
        persona: persona,
        macros: conversation.macros,
        tools: conversation.tools,
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

    // Validate the final conversation after all modifications
    this.validateConversationDocument(
      conversation,
      "startChatSession",
      "final_conversation"
    );

    this.context.info("Successfully started chat session", {
      conversationId: conversation._id?.toString(),
      personaId: conversation.personaId,
      userId: conversation.user?.toString(),
      macrosCount: conversation.macros?.length || 0,
      toolsCount: conversation.tools?.length || 0,
      historyLength: conversation.history?.length || 0,
      tokenCount: conversation.tokenCount,
      maxTokens: conversation.maxTokens,
    });

    return conversation;
  }

  /**
   * Process multiple tool calls with proper orchestration
   * This method handles the execution of multiple tools in sequence or parallel
   */
  async processToolCalls(args: {
    toolCalls: any[];
    personaId: string;
    chatSessionId: string;
    executionMode?: "sequential" | "parallel";
    maxRetries?: number;
  }): Promise<any> {
    const {
      toolCalls,
      personaId,
      chatSessionId,
      executionMode = "sequential",
      maxRetries = 3,
    } = args;

    if (!toolCalls || toolCalls.length === 0) {
      return { results: [], errors: [] };
    }

    const results = [];
    const errors = [];

    // Get conversation once to validate it exists
    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    try {
      if (executionMode === "parallel") {
        // Execute tools in parallel for better performance
        const toolPromises = toolCalls.map(async (toolCall, index) => {
          return this.executeSingleToolCall(
            toolCall,
            conversation,
            index,
            maxRetries
          );
        });

        const toolResults = await Promise.allSettled(toolPromises);

        toolResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            results.push(result.value);
          } else {
            errors.push({
              toolCall: toolCalls[index],
              error: result.reason,
              index,
            });
          }
        });
      } else {
        // Execute tools sequentially for dependency management
        for (let i = 0; i < toolCalls.length; i++) {
          try {
            const result = await this.executeSingleToolCall(
              toolCalls[i],
              conversation,
              i,
              maxRetries
            );
            results.push(result);

            // Use atomic update to add tool result to conversation history
            await ReactorConversationModel.findOneAndUpdate(
              { _id: chatSessionId },
              {
                $push: {
                  history: {
                    id: new ObjectId(),
                    role: "tool",
                    content: `Tool ${toolCalls[i].function?.name} executed successfully`,
                    timestamp: new Date(),
                    tool_results: [result],
                    tool_call_id: toolCalls[i].id,
                  },
                },
                $set: { updated: new Date() },
              },
              { new: true }
            ).exec();
          } catch (error) {
            errors.push({
              toolCall: toolCalls[i],
              error: error.message,
              index: i,
            });

            // Use atomic update to add error message to conversation history
            await ReactorConversationModel.findOneAndUpdate(
              { _id: chatSessionId },
              {
                $push: {
                  history: {
                    id: new ObjectId(),
                    role: "tool",
                    content: `Tool ${toolCalls[i].function?.name} failed: ${error.message}`,
                    timestamp: new Date(),
                    tool_errors: [
                      {
                        name: toolCalls[i].function?.name,
                        error: error.message,
                      },
                    ],
                    tool_call_id: toolCalls[i].id,
                  },
                },
                $set: { updated: new Date() },
              },
              { new: true }
            ).exec();

            // Continue with next tool even if one fails
            this.context.warn(
              `Tool execution failed: ${toolCalls[i].function?.name}`,
              { error }
            );
          }
        }
      }

      // Send consolidated results back to AI provider
      if (results.length > 0) {
        const consolidatedResults = this.consolidateToolResults(results);
        const response = await this.sendMessage({
          personaId,
          chatSessionId,
          message: consolidatedResults,
          role: "tool",
          tool_name: "consolidated_results",
          tool_args: { results, errors },
          tool_call_id: `consolidated_${Date.now()}`,
        });

        return {
          results,
          errors,
          consolidatedResponse: response,
        };
      }

      return { results, errors };
    } catch (error) {
      this.context.error(`Error processing tool calls: ${error.message}`, {
        error,
      });
      throw error;
    }
  }

  /**
   * Execute a single tool call with retry logic
   */
  private async executeSingleToolCall(
    toolCall: any,
    conversation: any,
    index: number,
    maxRetries: number
  ): Promise<any> {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { function: func } = toolCall;
        if (!func || !func.name) {
          throw new Error("Invalid tool call: missing function name");
        }

        // Check if tool exists in conversation
        const toolDef = conversation.tools.find(
          (t: any) => t.function?.name === func.name
        );
        if (!toolDef) {
          throw new Error(`Tool ${func.name} not found in conversation`);
        }

        // Execute the tool
        const result = await this.executeMacro({
          macro: func.name,
          personaId: conversation.personaId,
          chatSessionId: conversation._id.toString(),
          args: func.arguments || {},
          calledBy: "assistant",
          callId: toolCall.id,
        });

        return {
          id: toolCall.id,
          name: func.name,
          result,
          index,
          attempt,
          timestamp: new Date(),
        };
      } catch (error) {
        lastError = error;
        this.context.warn(
          `Tool execution attempt ${attempt} failed: ${toolCall.function?.name}`,
          { error }
        );

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 1000)
          );
        }
      }
    }

    throw new Error(
      `Tool ${toolCall.function?.name} failed after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Check if an AI response is actually an error response
   */
  private isErrorResponse(response: any): boolean {
    if (!response) return true;

    // Check if it's a ReactorErrorResponse
    if (response.__typename === "ReactorErrorResponse") {
      return true;
    }

    // Check if it's an error response from AI providers
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      const content = choice.message?.content || "";

      // Check for error indicators in content
      const errorIndicators = [
        "i'm experiencing some technical difficulties",
        "i'm unable to provide",
        "error occurred",
        "something went wrong",
        "please try again",
        "technical difficulties",
      ];

      return errorIndicators.some((indicator) =>
        content.toLowerCase().includes(indicator)
      );
    }

    return false;
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = error.code?.toLowerCase() || "";

    // Retryable errors
    const retryablePatterns = [
      "unexpected_tool_call",
      "malformed_function_call",
      "missing_content_field",
      "malformed_content",
      "empty_response",
      "other_finish_reason",
      "rate limit",
      "timeout",
      "network",
      "connection",
      "temporary",
      "service unavailable",
      "internal server error",
      "bad gateway",
      "gateway timeout",
      "ai provider error",
      "retryable",
    ];

    return retryablePatterns.some(
      (pattern) => errorMessage.includes(pattern) || errorCode.includes(pattern)
    );
  }

  /**
   * Consolidate multiple tool results into a single response
   */
  private consolidateToolResults(results: any[]): string {
    if (results.length === 1) {
      return results[0].result?.content || JSON.stringify(results[0].result);
    }

    const consolidated = results
      .map((result, index) => {
        const content = result.result?.content || JSON.stringify(result.result);
        return `Tool ${index + 1} (${result.name}): ${content}`;
      })
      .join("\n\n");

    return `Multiple tools executed successfully:\n\n${consolidated}`;
  }

  /**
   * Process large documents with chunking and summarization
   */
  async processLargeDocument(args: {
    content: string;
    personaId: string;
    chatSessionId: string;
    options?: {
      maxChunkSize?: number;
      overlapSize?: number;
      chunkBy?: "tokens" | "sentences";
      preserveStructure?: boolean;
      includeSummary?: boolean;
      summaryStrategy?: "individual" | "hierarchical" | "final";
    };
  }): Promise<{
    results: any[];
    summary: {
      totalChunks: number;
      processedChunks: number;
      failedChunks: number;
      totalTokens: number;
      originalSize: number;
      processingTime: number;
      finalSummary?: string;
    };
  }> {
    const { content, personaId, chatSessionId, options = {} } = args;

    if (!this.chunkingService) {
      throw new Error("DocumentChunkingService not available");
    }

    // Monitor document size first
    const sizeInfo = this.chunkingService.monitorDocumentSize(content);
    if (sizeInfo.warnings.length > 0) {
      this.context.warn(
        "Large document detected",
        {
          warnings: sizeInfo.warnings,
          recommendations: sizeInfo.recommendations,
        },
        "ReactorConversationService.processLargeDocument"
      );
    }

    // Process the document using the chunking service
    return await this.chunkingService.processLargeDocumentWithAI(
      content,
      this.sendMessage.bind(this),
      { personaId, _id: chatSessionId },
      options
    );
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorConversationService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "Service for managing reactor chat conversations";
  tags?: string[] = ["ai", "chat", "conversations"];
  nameSpace: string = "reactor";
  name: string = "Reactor Conversation Service";
  version: string = "1.0.0";
}
