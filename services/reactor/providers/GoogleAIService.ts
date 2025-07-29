import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import GoogleGenAI, {
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  Type,
} from "@google/genai";
import {
  AIChatParams,
  AIAudioChatParams,
  AIChatCompletion,
} from "../../../types/model.types";
import { IAIPersona } from "../../../types/service.types";
import AIPersonaProvider from "../AIPersonaProvider";
import AIProviderBase from "./AIProviderBase";
import { AIProviderError } from "./AIProviderError";
import { ObjectId } from "mongodb";
import ReactorMacroService from "./ReactorMacroService";
import {
  MacroComponentDefinition,
  MacroToolDefinition,
} from "modules/reactory-reactor/ai/openai/types/chat";
import {
  ChatHistoryItem,
  ReactorConversationHistoryItem,
  ReactorToolResult,
  ValidProviderResponseTypes,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessage,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources";
@service({
  id: "reactor.GoogleAIService@1.0.0",
  name: "Google AI Service",
  nameSpace: "reactor",
  description: "Service for managing Google AI API requests",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
  ],
})
class GoogleAIService extends AIProviderBase {
  ai: GoogleGenAI.GoogleGenAI;
  model: GoogleGenAI.Model;
  fileService: Reactory.Service.IReactoryFileService;
  userService: Reactory.Service.IReactoryUserService;
  fetchService: Reactory.Service.IFetchService;
  macroService: ReactorMacroService;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    super(props, context);
  }

  protected async initializeClient(persona: IAIPersona): Promise<void> {
    const apiKey = persona.config?.apiKey || process.env.GOOGLE_AI_API_KEY;
    const project = persona.config?.project || process.env.GOOGLE_AI_PROJECT_ID;
    if (!apiKey) {
      throw new AIProviderError("Google AI API key is not set");
    }

    this.ai = new GoogleGenAI.GoogleGenAI({
      apiKey,
    });
    const modelId =
      persona.modelId || process.env.GOOGLE_AI_MODEL_ID || "gemini-pro";
    this.model = await this.ai.models.get({
      model: modelId,
      config: persona?.modelConfig,
    });
  }

  // Always return lowercase type string for Gemini compatibility
  private getTypeEnum(type: string): Type {
    switch (type?.toLowerCase()) {
      case "string":
        return Type.STRING;
      case "number":
        return Type.NUMBER;
      case "boolean":
        return Type.BOOLEAN;
      case "object":
        return Type.OBJECT;
      case "array":
        return Type.ARRAY;
      default:
        return Type.STRING;
    }
  }

  private toPropertiesRecord(
    properties: Record<string, any>
  ): Record<string, GoogleGenAI.Schema> {
    const record: Record<string, GoogleGenAI.Schema> = {};
    for (const [key, value] of Object.entries(properties)) {
      record[key] = this.handleObjectProperties(value);
    }
    return record;
  }

  private handleObjectProperties(value: any): GoogleGenAI.Schema {
    const schema: GoogleGenAI.Schema = {
      type: this.getTypeEnum(value.type),
      description: value.description ?? "",
    };
    if (value.enum) schema.enum = value.enum;
    if (value.format) schema.format = value.format;
    if (
      value.type &&
      this.getTypeEnum(value.type) === Type.OBJECT &&
      value.properties
    ) {
      schema.properties = this.toPropertiesRecord(value.properties);
      if (value.required) schema.required = value.required;
    }
    if (
      value.type &&
      this.getTypeEnum(value.type) === Type.ARRAY &&
      value.items
    ) {
      schema.items = this.handleArrayItems(value.items);
    }
    return schema;
  }

  private handleArrayItems(items: any): any {
    if (Array.isArray(items)) {
      return items.map((item: any) => {
        if (
          item.type &&
          this.getTypeEnum(item.type) === Type.OBJECT &&
          item.properties
        ) {
          return {
            ...item,
            properties: this.toPropertiesRecord(item.properties),
          };
        }
        return item;
      });
    } else if (
      items.type &&
      this.getTypeEnum(items.type) === Type.OBJECT &&
      items.properties
    ) {
      return {
        ...items,
        properties: this.toPropertiesRecord(items.properties),
      };
    } else {
      return items;
    }
  }

  private async getAITools(): Promise<GoogleGenAI.ToolListUnion> {
    const functions: FunctionDeclaration[] = [];
    const tools = this.chatState.tools;
    tools.forEach((tool: MacroToolDefinition) => {
      const functionDeclaration: FunctionDeclaration = {
        name: tool.function.name,
        parameters: {
          type: Type.OBJECT,
          description: tool.function.description,
          properties: this.toPropertiesRecord(tool.function.parameters.properties),
          required: tool.function.parameters.required,
        }
      };
      functions.push(functionDeclaration);
    });
    // const macros = this.chatState.macros;

    // macros.forEach((macro: MacroComponentDefinition<unknown>) => {
    //   if (macro.tools && macro.tools.length > 0) {
    //     macro.tools.forEach((tool: MacroToolDefinition) => {
    //       const paramProps = tool.function.parameters.properties ?? {};
    //       const paramRequired = tool.function.parameters.required ?? [];
    //       const functionDeclaration: FunctionDeclaration = {
    //         name: tool.function.name,
    //         parameters: {
    //           type: Type.OBJECT,
    //           description:
    //             tool.function.description ??
    //             `Execute the ${tool.function.name} function.`,
    //           properties: this.toPropertiesRecord(paramProps),
    //           ...(paramRequired.length > 0 ? { required: paramRequired } : {}),
    //         },
    //       };
    //       functions.push(functionDeclaration);
    //     });
    //   }
    // });

    return [
      {
        // /** Optional. Retrieval tool type. System will always execute the provided retrieval tool(s) to get external knowledge to answer the prompt. Retrieval results are presented to the model for generation. */
        //     retrieval?: Retrieval;
        //     /** Optional. Google Search tool type. Specialized retrieval tool
        //      that is powered by Google Search. */
        //     googleSearch?: GoogleSearch;
        //     /** Optional. GoogleSearchRetrieval tool type. Specialized retrieval tool that is powered by Google search. */
        //     googleSearchRetrieval?: GoogleSearchRetrieval;
        //     /** Optional. Enterprise web search tool type. Specialized retrieval
        //      tool that is powered by Vertex AI Search and Sec4 compliance. */
        //     enterpriseWebSearch?: EnterpriseWebSearch;
        //     /** Optional. Google Maps tool type. Specialized retrieval tool
        //      that is powered by Google Maps. */
        //     googleMaps?: GoogleMaps;
        //     /** Optional. CodeExecution tool type. Enables the model to execute code as part of generation. This field is only used by the Gemini Developer API services. */
        //     codeExecution?: ToolCodeExecution;
        functionDeclarations: functions,
      },
    ];
  }

  private getPartsForAssistantMessage(
    msg:
      | (ChatCompletionMessage & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          rating?: number;
          content?: any;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
      | (ChatCompletionAssistantMessageParam & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          content?: any;
          rating?: number;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
      | (ChatCompletionToolMessageParam & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          rating?: number;
          content?: any;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
  ): any[] {
    /**
     * Converts an assistant or tool message to Google GenAI "parts" format.
     * Handles tool calls, tool results, and normal assistant responses.
     */
    const parts: any[] = [];

    // If the message contains tool calls, add them as functionCall parts
    if (
      "tool_calls" in msg &&
      msg.tool_calls &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      for (const toolCall of msg.tool_calls) {
        // Google expects functionCall in a specific format
        let args = toolCall.function?.arguments ?? (toolCall as any).arguments ?? {};
        
        // If args is a string, try to parse it as JSON
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch (e) {
            // If parsing fails, use as-is
            this.context.warn("Failed to parse function arguments as JSON", { args }, "GoogleAIService");
          }
        }
        
        parts.push({
          functionCall: {
            name: toolCall.function?.name || (toolCall as any).name,
            args: args,
          },
        });
      }
    }

    // If the message contains tool results (tool responses), add them as functionResponse parts
    if (
      msg.tool_results &&
      Array.isArray(msg.tool_results) &&
      msg.tool_results.length > 0
    ) {
      for (const toolResult of msg.tool_results) {
        let response = toolResult?.content ?? toolResult?.result ?? toolResult;
        
        // If response is a string, try to parse it as JSON
        if (typeof response === "string") {
          try {
            response = JSON.parse(response);
          } catch (e) {
            // If parsing fails, use as-is
            this.context.warn("Failed to parse tool result response as JSON", { response }, "GoogleAIService");
          }
        }
        
        parts.push({
          functionResponse: {
            name: toolResult.tool_name || toolResult.name,
            response: response,
            // Optionally include tool_call_id if present
            ...(toolResult.tool_call_id
              ? { tool_call_id: toolResult.tool_call_id }
              : {}),
          },
        });
      }
    }

    // If the message has content (assistant/model response), add as text part
    if (msg.content) {
      // If content is an array, flatten to string
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (typeof c === "string") {
            parts.push({ text: c });
          } else if (
            c &&
            typeof c === "object" &&
            "text" in c &&
            typeof (c as any).text === "string"
          ) {
            parts.push({ text: (c as any).text });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (
        msg.content &&
        typeof msg.content === "object" &&
        "text" in msg.content &&
        typeof (msg.content as any).text === "string"
      ) {
        parts.push({ text: (msg.content as any).text });
      }
    }

    // If no parts were added, add an empty text part to avoid Google API errors
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    return parts;
  }

  private getPartsForUserMessage(
    msg: ChatCompletionUserMessageParam & {
      id: string | ObjectId;
      response?: ValidProviderResponseTypes;
      rating?: number;
      component?: string;
      timestamp: Date;
      tool_name?: string;
      tool_args?: any;
      tool_call_id?: string;
      tool_results?: ReactorToolResult[];
    }
  ): any[] {
    // For a user message, Google expects an array of parts, each with a "text" property.
    // We'll handle the most common cases: string content, array of strings, or object with text.
    const parts: any[] = [];

    if (msg.content) {
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (typeof c === "string") {
            parts.push({ text: c });
          } else if (
            c &&
            typeof c === "object" &&
            "text" in c &&
            typeof (c as any).text === "string"
          ) {
            parts.push({ text: (c as any).text });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (
        msg.content &&
        typeof msg.content === "object" &&
        "text" in msg.content &&
        typeof (msg.content as any).text === "string"
      ) {
        parts.push({ text: (msg.content as any).text });
      }
    }

    // If no parts were added, add an empty text part to avoid Google API errors
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    return parts;
  }

  private async createChatSession(history: ReactorConversationHistoryItem[]) {
    try {
      if (!this.model) {
        throw new AIProviderError("Google AI model not initialized");
      }

      // Convert history to Google AI format
      // get the system instruction from the first message if it exists
      const systemInstruction =
        history.find((msg) => msg.role === "system")?.content ?? "";

      const googleHistory: any[] = [];
      // add the system instruction to the history as a user message
      googleHistory.push({
        role: "user",
        parts: [{ text: systemInstruction }],
      });

      // add a simulated assistant message to indicate a response to the system instruction
      googleHistory.push({
        role: "model",
        parts: [{ text: "I'm ready to help you with your request." }],
      });

      history.forEach((msg) => {
        
        let googleRole = "user";
        let parts: any[] = [];
        switch (msg.role) {
          case "assistant":
          case "tool":
            googleRole = "model";
            // check if the message has tool calls
            parts = this.getPartsForAssistantMessage(msg);
            break;
          default:
            googleRole = "user";
            //@ts-ignore
            parts = this.getPartsForUserMessage(msg);
            break;
        }

        let googleHistoryItem: any = {
          role: googleRole,
          parts,
        };

        googleHistory.push(googleHistoryItem);
      });

      const tools = await this.getAITools();

      // Create chat session with generation config
      return this.ai.chats.create({
        model: this.model.name,
        history: googleHistory,
        config: {
          tools: tools,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO, // Automatically determine when to call functions
            },
          },
          // systemInstruction,
          temperature: 0.7,
          topP: 1.0,
          frequencyPenalty: 0.0,
          presencePenalty: 0.0,
        },
      });
    } catch (error) {
      this.context.error(
        `Error creating chat session: ${error.message}`,
        { error, historyLength: history.length },
        "GoogleAIService.createChatSession"
      );
      
      // Return null instead of throwing to allow fallback handling
      return null;
    }
  }

  private async getAIResponse(
    message: string,
    role: "user" | "assistant" | "tool" | "system" = "user",
    tool_name?: string,
    tool_args?: any,
    tool_call_id?: string
  ): Promise<AIChatCompletion> {
    try {
      // get the persona from the chat state
      const persona: IAIPersona = await this.personaProvider.getPersona(
        this.chatState.personaId
      );

      // Handle tool results differently - add them to history and get next response
      if (role === "tool") {

   
        // Create a new chat session with updated history
        const chat = await this.createChatSession(this.chatState.history);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Send an empty message to get the next response from the AI
        const result = await chat.sendMessage({
          config: persona.messageConfig,
          message: "",
        });

        this.context.log(
          `Received response from Google AI after tool result`,
          { result: JSON.stringify(result, null, 2) },
          "GoogleAIService.getAIResponse"
        );

        // Validate and extract response
        if (!result || typeof result !== "object") {
          throw new AIProviderError(
            "Invalid response from Google AI: result is not an object"
          );
        }
        if (
          !Array.isArray(result.candidates) ||
          result.candidates.length === 0
        ) {
          throw new AIProviderError("No candidates returned from Google AI");
        }
        const candidate = result.candidates[0];
        const { responseText, functionCalls } =
          this.extractGeminiCandidate(candidate);

        // Format response similar to OpenAI for compatibility
        const completion: AIChatCompletion = {
          id: new ObjectId(),
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                content: responseText,
                role: "assistant",
                tool_calls: functionCalls
                  ? [
                      ...functionCalls.map((func) => ({
                        id: new ObjectId().toString(),
                        type: "function",
                        function: {
                          name: func.name,
                          arguments: func.args,
                        },
                      })),
                    ]
                  : [],
              },
              finish_reason: "stop",
            },
          ],
          created: new Date(),
        };

        return completion;
      }

      // Handle user messages
      if (role === "user") {
        // Create a chat session with history
        const chat = await this.createChatSession(this.chatState.history);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Send the message and get response
        this.context.log(
          `Sending message to Google AI: ${message}`,
          {},
          "GoogleAIService.getAIResponse"
        );

        const result = await chat.sendMessage({
          config: persona.messageConfig,
          message,
        });

        this.context.log(
          `Received response from Google AI`,
          { result: JSON.stringify(result, null, 2) },
          "GoogleAIService.getAIResponse"
        );

        // Improved Gemini response validation and extraction
        if (!result || typeof result !== "object") {
          this.context.error(
            "Invalid response from Google AI: result is not an object",
            { result },
            "GoogleAIService.getAIResponse"
          );
          throw new AIProviderError(
            "I received an invalid response from the AI service. Please try again."
          );
        }
        
        if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
          this.context.error(
            "No candidates returned from Google AI",
            { result },
            "GoogleAIService.getAIResponse"
          );
          throw new AIProviderError(
            "I didn't receive a proper response from the AI service. Please try again."
          );
        }
        
        const candidate = result.candidates[0];
        
        try {
          const { responseText, functionCalls } = this.extractGeminiCandidate(candidate);
          
          if (functionCalls.length > 0) {
            this.context.log(
              `Function/tool call detected in Gemini response`,
              { functionCalls },
              "GoogleAIService.getAIResponse"
            );
          }
          
          // we add the user conversation history item after the
          // AI response, because we derive the history from the
          // chat state and we pass the user message to the AI which
          // sees it as part of the conversation. So if we added the
          // user message before the AI response, the user message
          // would already be in the history and the AI would see it as part of the conversation.
          const userConversationHistoryItem: ReactorConversationHistoryItem = {
            id: new ObjectId(),
            role: "user",
            content: message,
            timestamp: new Date(),
            tool_results: [],
          };

          // Add user message to history
          this.chatState.history.push(userConversationHistoryItem);

          // Format response similar to OpenAI for compatibility
          const completion: AIChatCompletion = {
            id: new ObjectId(),
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  content: responseText,
                  role: "assistant",
                  tool_calls: functionCalls
                    ? [
                        ...functionCalls.map((func) => ({
                          id: new ObjectId().toString(),
                          type: "function",
                          function: {
                            name: func.name,
                            arguments: func.args,
                          },
                        })),
                      ]
                    : [],
                },
                finish_reason: "stop",
              },
            ],
            created: new Date(),
          };

          return completion;
        } catch (extractError) {
          this.context.error(
            `Error extracting Gemini candidate: ${extractError.message}`,
            { candidate, error: extractError },
            "GoogleAIService.getAIResponse"
          );
          
          // Return a fallback response instead of throwing
          const userConversationHistoryItem: ReactorConversationHistoryItem = {
            id: new ObjectId(),
            role: "user",
            content: message,
            timestamp: new Date(),
            tool_results: [],
          };

          this.chatState.history.push(userConversationHistoryItem);

          return {
            id: new ObjectId(),
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  content: "I encountered an issue processing the response. Let me try to help you in a different way.",
                  role: "assistant",
                  tool_calls: [],
                },
                finish_reason: "stop",
              },
            ],
            created: new Date(),
          };
        }
      }

      // Handle other roles (assistant, system) - just add to history without getting response
      const historyItem = {
        id: new ObjectId(),
        role,
        content: message,
        timestamp: new Date(),
        tool_results: [],
      } as ReactorConversationHistoryItem;

      this.chatState.history.push(historyItem);

      // Return empty completion for non-user/tool messages
      return {
        id: new ObjectId(),
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
        created: new Date(),
      };
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message ?? error.toString()}`,
        { error },
        "GoogleAIService.getAIResponse"
      );
      throw error;
    }
  }

  private extractGeminiCandidate(candidate: any): {
    responseText: string;
    functionCalls: any[];
  } {
    if (!candidate || typeof candidate !== "object") {
      throw new AIProviderError("Invalid candidate in Google AI response");
    }

    // Handle special finish reasons that indicate issues
    if (candidate.finishReason) {
      switch (candidate.finishReason) {
        case "UNEXPECTED_TOOL_CALL":
          this.context.warn(
            "Gemini encountered an unexpected tool call - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error instead of returning fallback
          throw new AIProviderError("UNEXPECTED_TOOL_CALL");
        
        case "MALFORMED_FUNCTION_CALL":
          this.context.warn(
            "Gemini encountered a malformed function call - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error instead of returning fallback
          throw new AIProviderError("MALFORMED_FUNCTION_CALL");
        
        case "SAFETY":
          this.context.warn(
            "Gemini response blocked by safety filters",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          return {
            responseText: "I'm unable to provide a response due to safety considerations. Please try rephrasing your question.",
            functionCalls: []
          };
        
        case "RECITATION":
          this.context.warn(
            "Gemini response blocked due to recitation concerns",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          return {
            responseText: "I'm unable to provide that specific information. Let me help you with a different approach.",
            functionCalls: []
          };
        
        case "OTHER":
          this.context.warn(
            "Gemini response finished with OTHER reason - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error for OTHER finish reasons
          throw new AIProviderError("OTHER_FINISH_REASON");
      }
    }

    // Check if content field exists
    if (!candidate.content) {
      this.context.warn(
        "Candidate missing content field - will retry",
        { candidate, finishReason: candidate.finishReason },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for missing content
      throw new AIProviderError("MISSING_CONTENT_FIELD");
    }

    if (typeof candidate.content !== "object") {
      this.context.warn(
        "Candidate content is not an object - will retry",
        { candidate },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for malformed content
      throw new AIProviderError("MALFORMED_CONTENT");
    }

    let responseText = "";
    let functionCalls: any[] = [];

    // Extract content from parts
    if (Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0) {
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
        if (part.text) {
          responseText += part.text;
        }
      }
    }

    // If no content was extracted, provide a fallback
    if (functionCalls.length === 0 && !responseText.trim()) {
      this.context.warn(
        "No text or function call found in Gemini candidate response - will retry",
        { candidate },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for empty responses
      throw new AIProviderError("EMPTY_RESPONSE");
    }

    return { responseText: responseText.trim(), functionCalls };
  }

  async chat(params: AIChatParams & { persistState?: boolean }): Promise<AIChatCompletion> {
    const {
      personaId,
      chatSessionId,
      message,
      role = "user",
      tool_name,
      tool_args,
      tool_call_id,
      persistState = true, // Default to true for backward compatibility
    } = params;

    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Initialize if needed
        if (
          !this.ai ||
          !this.model ||
          (chatSessionId && this.chatState?.id !== chatSessionId)
        ) {
          const persona = this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId, persona);
        }

        // Modify message on retry to potentially avoid the same error
        const modifiedMessage = attempt > 1 ? this.modifyMessageForRetry(message, lastError) : message;

        // Get response from AI
        const response = await this.getAIResponse(modifiedMessage, role);
        
        // Add AI response to history
        if (response.choices && response.choices.length > 0) {
          this.chatState.history.push({
            id: new ObjectId(),
            timestamp: new Date(),
            // @ts-ignore
            tool_calls: response.choices[0].message.tool_calls ?? [],
            tool_results: [],
            role: "assistant",
            content: response.choices[0].message.content,
          });
        }

        // Only persist chat state if explicitly requested
        // This prevents duplicate persistence when called from ReactorConversationService
        if (persistState) {
          await this.persistChatState();
        }

        return response;
      } catch (error: any) {
        lastError = error;
        
        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(error);
        
        if (attempt < maxRetries && isRetryable) {
          this.context.warn(
            `Retry attempt ${attempt} for Google AI chat (${error.message})`,
            { error, attempt, maxRetries, isRetryable },
            "GoogleAIService.chat"
          );
          
          // Wait before retry with exponential backoff
          const backoffDelay = Math.pow(2, attempt) * 1000;
          this.context.log(
            `Waiting ${backoffDelay}ms before retry attempt ${attempt + 1}`,
            { backoffDelay, attempt },
            "GoogleAIService.chat"
          );
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          continue;
        }
        
        // If not retryable or max retries reached, break and throw
        break;
      }
    }

    // If we get here, all retries failed
    this.context.error(
      `Error in chat after ${maxRetries} attempts: ${lastError?.message ?? lastError?.toString()}`,
      { error: lastError, params },
      "GoogleAIService.chat"
    );
    
    // Return a graceful error response instead of throwing
    return {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            content: "I'm experiencing some technical difficulties right now. Please try again in a moment, or rephrase your question.",
            role: "assistant",
            tool_calls: [],
          },
          finish_reason: "stop",
        },
      ],
      created: new Date(),
    };
  }

  /**
   * Modify the message on retry to potentially avoid the same error
   */
  private modifyMessageForRetry(message: string, lastError: any): string {
    const errorMessage = lastError?.message?.toLowerCase() || '';
    
    // For tool call related errors, try to simplify the request
    if (errorMessage.includes('unexpected_tool_call') || errorMessage.includes('malformed_function_call')) {
      this.context.log(
        "Modifying message for retry to avoid tool call issues",
        { originalMessage: message, error: lastError.message },
        "GoogleAIService.modifyMessageForRetry"
      );
      
      // Add a prefix to encourage a simpler response
      return `Please provide a simple, direct response to: ${message}`;
    }
    
    // For other errors, just return the original message
    return message;
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toLowerCase() || '';
    
    // Retryable errors
    const retryablePatterns = [
      'unexpected_tool_call',
      'malformed_function_call',
      'missing_content_field',
      'malformed_content',
      'empty_response',
      'other_finish_reason',
      'rate limit',
      'timeout',
      'network',
      'connection',
      'temporary',
      'service unavailable',
      'internal server error',
      'bad gateway',
      'gateway timeout'
    ];
    
    return retryablePatterns.some(pattern => 
      errorMessage.includes(pattern) || errorCode.includes(pattern)
    );
  }

  // Override only needed methods, using base class implementations for others
  async chatAudio(params: AIAudioChatParams): Promise<AIChatCompletion> {
    this.context.warn("chatAudio not implemented", {}, "GoogleAIService");
    throw new AIProviderError("Method not implemented");
  }

  async speech2Text(audio: string | Buffer[]): Promise<string> {
    this.context.warn("speech2Text not implemented", {}, "GoogleAIService");
    throw new AIProviderError("Method not implemented");
  }

  // Dependency injection setters
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

  setMacroService(macroService: ReactorMacroService) {
    this.macroService = macroService;
  }

  toString(includeVersion?: boolean): string {
    return `GoogleAIService${includeVersion ? "@1.0.0" : ""}`;
  }

  description = "Service for managing Google AI API requests";
  tags = ["ai", "google", "gemini"];
  nameSpace = "reactor";
  name = "GoogleAIService";
  version = "1.0.0";
}

export default GoogleAIService;
