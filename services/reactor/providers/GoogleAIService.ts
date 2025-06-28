import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import GoogleGenAI, { FunctionCallingConfigMode, FunctionDeclaration, Type } from "@google/genai";
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
import { MacroComponentDefinition, MacroToolDefinition } from "modules/reactory-reactor/ai/openai/types/chat";
import { ReactorConversationHistoryItem } from "modules/reactory-reactor/models/ReactorChatState";

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

  private toPropertiesRecord(properties: Record<string, any>): Record<string, GoogleGenAI.Schema> {
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
    if (value.type && this.getTypeEnum(value.type) === Type.OBJECT && value.properties) {
      schema.properties = this.toPropertiesRecord(value.properties);
      if (value.required) schema.required = value.required;
    }
    if (value.type && this.getTypeEnum(value.type) === Type.ARRAY && value.items) {
      schema.items = this.handleArrayItems(value.items);
    }
    return schema;
  }

  private handleArrayItems(items: any): any {
    if (Array.isArray(items)) {
      return items.map((item: any) => {
        if (item.type && this.getTypeEnum(item.type) === Type.OBJECT && item.properties) {
          return { ...item, properties: this.toPropertiesRecord(item.properties) };
        }
        return item;
      });
    } else if (items.type && this.getTypeEnum(items.type) === Type.OBJECT && items.properties) {
      return { ...items, properties: this.toPropertiesRecord(items.properties) };
    } else {
      return items;
    }
  }

  private async getAITools(): Promise<GoogleGenAI.ToolListUnion> {
    const functions: FunctionDeclaration[] = [];
    const macros = await this.macroService.listMacrosForPersona(this.chatState.personaId);
    macros.forEach((macro: MacroComponentDefinition<unknown>) => { 
      if (macro.tools && macro.tools.length > 0) { 
        macro.tools.forEach((tool: MacroToolDefinition) => {
          const paramProps = tool.function.parameters.properties ?? {};
          const paramRequired = tool.function.parameters.required ?? [];
          const functionDeclaration: FunctionDeclaration = {
            name: tool.function.name,            
            parameters: {
              type: Type.OBJECT,
              description: tool.function.description ?? `Execute the ${tool.function.name} function.`,
              properties: this.toPropertiesRecord(paramProps),
              ...(paramRequired.length > 0 ? { required: paramRequired } : {})
            },
          };
          functions.push(functionDeclaration);
        });              
      }
    });

    return [{ 
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
    }];
  }

  private async createChatSession(history: any[]) {
    try {
      // Convert history to Google AI format
      // get the system instruction from the first message if it exists
      const systemInstruction = history.find(
        (msg) => msg.role === "system"
      )?.content ?? "";

      const googleHistory: any[] = [] 
      history.forEach((msg) => {                
        if (!msg?.content) {
          this.context.warn(
            "Skipping invalid message in history",
            { msg },
            "GoogleAIService.createChatSession"
          );
          return;
        }

        if (msg.role !== "user" && msg.role !== "assistant") {          
          return;
        }

        googleHistory.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }],
        });
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
            }
          },
          systemInstruction,
          temperature: 0.7,
          topP: 1.0,
          frequencyPenalty: 0.0,
          presencePenalty: 0.0,
        },
      });
    } catch (error) {
      this.context.error(
        `Error creating chat session: ${error.message ?? error.toString()}`,
        { error },
        "GoogleAIService.createChatSession"
      );
      throw error;
    }
  }

  private async getAIResponse(message: string): Promise<AIChatCompletion> {
    try {
      // get the persona from the chat state
      const persona: IAIPersona = this.personaProvider.getPersona(
        this.chatState.personaId
      );

      
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
      if (!result || typeof result !== 'object') {
        throw new AIProviderError('Invalid response from Google AI: result is not an object');
      }
      if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
        throw new AIProviderError('No candidates returned from Google AI');
      }
      const candidate = result.candidates[0];
      const { responseText, functionCall } = this.extractGeminiCandidate(candidate);
      if (functionCall) {
        this.context.log(
          `Function/tool call detected in Gemini response`,
          { functionCall },
          "GoogleAIService.getAIResponse"
        );
        // You can add logic here to handle the function call as needed
      } else if (!responseText) {
        throw new AIProviderError('No text or function call found in Gemini candidate response');
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
              tool_calls: functionCall ? [{
              id: new ObjectId().toString(),
              type: "function",
              function: {
                name: functionCall.name,
                arguments: functionCall.args,
              },
            }] : [],
            },
            finish_reason: "stop",            
          },
        ],
        created: new Date(),
      };

      return completion;
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message ?? error.toString()}`,
        { error },
        "GoogleAIService.getAIResponse"
      );
      throw error;
    }
  }

  private extractGeminiCandidate(candidate: any): { responseText: string; functionCall: any } {
    if (!candidate || typeof candidate !== 'object') {
      throw new AIProviderError('Invalid candidate in Google AI response');
    }
    if (!candidate.content || typeof candidate.content !== 'object') {
      throw new AIProviderError('Candidate missing content field');
    }
    let responseText = '';
    let functionCall = undefined;
    if (Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0) {
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          functionCall = part.functionCall;
          responseText = part.text ?? `Calling function... ${functionCall?.name}`;
          break;
        }
      }
      if (!functionCall) {
        responseText = candidate.content.parts.map((part: any) => part.text ?? '').join('');
      }
    }
    if (!functionCall && !responseText) {
      throw new AIProviderError('No text or function call found in Gemini candidate response');
    }
    return { responseText, functionCall };
  }

  async chat(params: AIChatParams): Promise<AIChatCompletion> {
    const { personaId, chatSessionId, message } = params;

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

      // Get response from AI
      const response = await this.getAIResponse(message);
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

      // Persist updated chat state
      await this.persistChatState();

      return response;
    } catch (error) {
      this.context.error(
        `Error in chat: ${error.message ?? error.toString()}`,
        { error, params },
        "GoogleAIService.chat"
      );
      throw error;
    }
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
