import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorProviderService } from "../../types/service.types";

/**
 * Service for managing AI provider integrations
 */
@service({
  id: "reactor.ReactorProviderService@1.0.0",
  name: "Reactor Provider Service",
  nameSpace: "reactor",
  description: "Service for managing AI provider integrations and abstractions",
  serviceType: "ai",
})
class ReactorProviderService implements IReactorProviderService {
  context: Reactory.Server.IReactoryContext;
  private providers: Map<string, any> = new Map();
  private adapters: Map<string, any> = new Map();

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.initialize();
  }

  private async initialize() {
    // Register built-in providers
    await this.registerOpenAIProvider();
    await this.registerXAIProvider();
    await this.registerGoogleProvider();
    await this.registerAmazonProvider();
    await this.registerAnthropicProvider();
    await this.registerCohereProvider();
    // TODO: Add dynamic provider discovery
    // via component search or other means.
  }

  private async registerOpenAIProvider() {
    const openaiConfig = {
      id: "openai",
      name: "OpenAI",
      endpointUrl: process.env.OPENAI_API_URL || "https://api.openai.com/v1",
      apiVersion: "v1",
      models: [
        {
          id: "gpt-4",
          providerId: "openai",
          name: "GPT-4",
          version: "1",
          capabilities: ["text-generation", "code-generation", "image-understanding"],
          contextLength: 8192,
          supportsStreaming: true,
          supportedTools: ["function-calling"]
        },
        {
          id: "gpt-3.5-turbo",
          providerId: "openai",
          name: "GPT-3.5 Turbo",
          version: "1",
          capabilities: ["text-generation", "code-generation"],
          contextLength: 4096,
          supportsStreaming: true,
          supportedTools: ["function-calling"]
        }
      ],
      defaultModel: "gpt-3.5-turbo",
      status: {
        available: true,
        lastChecked: new Date(),
        uptime: 99.9,
        responseTime: 350,
        errorRate: 0.1,
      },
      capabilities: ["text-generation", "code-generation", "image-generation", "speech-to-text"],
      credentialRequirements: ["apiKey", "organization"]
    };

    this.providers.set("openai", openaiConfig);
    
    // Create adapter for OpenAI
    const openaiAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown provider error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.role && response.content) {
          return {
            __typename: "ReactorChatMessage",
            ...response,
          }
        }

        if (response.choices && response.choices.length > 0) {
          const message = response.choices[0].message;
          return {
            __typename: "ReactorChatMessage",
            sessionId: response.sessionId, 
            id: response.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(),
            tool_calls: message.tool_calls || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("openai", openaiAdapter);
  }

  private async registerXAIProvider() {
    const xaiConfig = {
      id: "xai",
      name: "X-AI",
      endpointUrl: process.env.XAI_API_URL || "https://api.x.ai/v1",
      apiVersion: "v1",
      models: [
        {
          id: "grok-2-latest",
          providerId: "xai",
          name: "Grok 2 [Latest]",
          version: "2",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 131072,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        },
        {
          id: "grok-3-mini-beta",
          providerId: "xai",
          name: "Grok 3 Mini [Beta]",
          version: "3",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 131072,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text"]
        }
      ],
      defaultModel: "grok-3-mini-beta",
      status: {
        available: `${process.env.XAI_API_KEY}`.trim() !== "",
        lastChecked: new Date(),
        uptime: 99.5,
        responseTime: 400,
        errorRate: 0.2,
      },
      capabilities: ["text-generation", "code-generation", "reasoning"],
      credentialRequirements: ["apiKey"]
    };

    this.providers.set("xai", xaiConfig);
    
    // Create adapter for X AI
    const xaiAdapter = {
      adaptResponse: (response: any): any => {
        
        if (response === null) { 
          return {
            __typename: "ReactorErrorResponse",
            code: "PROVIDER_ERROR",
            message: "No response from xAI",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown xAI error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.role && response.content) {
          return {
            __typename: "ReactorChatMessage",
            ...response,
          }
        }

        if (response.choices && response.choices.length > 0) {
          const message = response.choices[0].message;
          return {
            __typename: "ReactorChatMessage",
            sessionId: response.sessionId, 
            id: response.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(),
            tool_calls: message.tool_calls || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream/xai",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("xai", xaiAdapter);
  }

  private async registerGoogleProvider() {
    const googleConfig = {
      id: "google",
      name: "Google Gemini",
      endpointUrl: process.env.GOOGLE_AI_API_URL || "https://generativelanguage.googleapis.com",
      apiVersion: "v1",
      models: [
        {
          id: "gemini-pro",
          providerId: "google",
          name: "Gemini Pro",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 32768,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text"]
        },
        {
          id: "gemini-pro-vision",
          providerId: "google",
          name: "Gemini Pro Vision",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
          contextLength: 16384,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        }
      ],
      defaultModel: "gemini-pro",
      status: {
        available: process.env.GOOGLE_AI_API_KEY ? true : false,
        lastChecked: new Date(),
        uptime: 99.8,
        responseTime: 350,
        errorRate: 0.1,
      },
      capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
      credentialRequirements: ["apiKey"]
    };

    this.providers.set("google", googleConfig);
    
    // Create adapter for Google
    const googleAdapter = {
      adaptResponse: (response: any): any => {
        if (response === null) { 
          return {
            __typename: "ReactorErrorResponse",
            code: "PROVIDER_ERROR",
            message: "No response from xAI",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown xAI error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.role && response.content) {
          return {
            __typename: "ReactorChatMessage",
            ...response,
          }
        }

        if (response.choices && response.choices.length > 0) {
          const message = response.choices[0].message;
          return {
            __typename: "ReactorChatMessage",
            sessionId: response.sessionId, 
            id: response.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(),
            tool_calls: message.tool_calls || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream/google",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("google", googleAdapter);
  }

  private async registerAmazonProvider() {
    const amazonConfig = {
      id: "amazon",
      name: "Amazon Q",
      endpointUrl: process.env.AMAZON_Q_API_URL || "https://q.amazonaws.com",
      apiVersion: "v1",
      models: [
        {
          id: "amazon-titan",
          providerId: "amazon",
          name: "Amazon Titan",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 8192,
          supportsStreaming: true,
          supportedTools: ["aws-service-integration"],
          supportedMediaTypes: ["text"]
        },
        {
          id: "claude-3-haiku-aws",
          providerId: "amazon",
          name: "Claude 3 Haiku (via AWS)",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 200000,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        }
      ],
      defaultModel: "amazon-titan",
      status: {
        available: process.env.AWS_ACCESS_KEY_ID ? true : false,
        lastChecked: new Date(),
        uptime: 99.99,
        responseTime: 300,
        errorRate: 0.05,
      },
      capabilities: ["text-generation", "code-generation", "reasoning", "aws-service-integration"],
      credentialRequirements: ["awsAccessKeyId", "awsSecretAccessKey", "awsRegion"]
    };

    this.providers.set("amazon", amazonConfig);
    
    // Create adapter for Amazon
    const amazonAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Amazon error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.results && response.results.length > 0) {
          const result = response.results[0];
          
          return {
            __typename: "ReactorChatMessage",
            id: response.responseId || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: result.text || result.completion,
            timestamp: new Date(),
            tool_calls: result.toolUses || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream/amazon",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("amazon", amazonAdapter);
  }

  private async registerAnthropicProvider() {
    const anthropicConfig = {
      id: "anthropic",
      name: "Anthropic",
      endpointUrl: process.env.ANTHROPIC_API_URL || "https://api.anthropic.com",
      apiVersion: "v1",
      models: [
        {
          id: "claude-3-opus",
          providerId: "anthropic",
          name: "Claude 3 Opus",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
          contextLength: 200000,
          costPerToken: 0.00015,
          inputCostPerToken: 0.00003,
          outputCostPerToken: 0.00015,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        },
        {
          id: "claude-3-sonnet",
          providerId: "anthropic",
          name: "Claude 3 Sonnet",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
          contextLength: 200000,
          costPerToken: 0.00003,
          inputCostPerToken: 0.00001,
          outputCostPerToken: 0.00003,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        },
        {
          id: "claude-3-haiku",
          providerId: "anthropic",
          name: "Claude 3 Haiku",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
          contextLength: 200000,
          costPerToken: 0.00000025,
          inputCostPerToken: 0.00000025,
          outputCostPerToken: 0.00000125,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text", "image"]
        }
      ],
      defaultModel: "claude-3-haiku",
      status: {
        available: process.env.ANTHROPIC_API_KEY ? true : false,
        lastChecked: new Date(),
        uptime: 99.9,
        responseTime: 370,
        errorRate: 0.1,
      },
      capabilities: ["text-generation", "code-generation", "reasoning", "image-understanding"],
      credentialRequirements: ["apiKey"]
    };

    this.providers.set("anthropic", anthropicConfig);
    
    // Create adapter for Anthropic
    const anthropicAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.type || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Anthropic error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.content) {
          let combinedContent = "";
          // Combine blocks of text content
          if (Array.isArray(response.content)) {
            combinedContent = response.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('\n');
          } else {
            combinedContent = response.content;
          }
          
          return {
            __typename: "ReactorChatMessage",
            id: response.id || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: combinedContent,
            timestamp: new Date(),
            tool_calls: response.tool_calls || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream/anthropic",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("anthropic", anthropicAdapter);
  }

  private async registerCohereProvider() {
    const cohereConfig = {
      id: "cohere",
      name: "Cohere",
      endpointUrl: process.env.COHERE_API_URL || "https://api.cohere.ai",
      apiVersion: "v1",
      models: [
        {
          id: "command-r",
          providerId: "cohere",
          name: "Command R",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 128000,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text"]
        },
        {
          id: "command-r-plus",
          providerId: "cohere",
          name: "Command R+",
          version: "1.0",
          capabilities: ["text-generation", "code-generation", "reasoning"],
          contextLength: 128000,
          supportsStreaming: true,
          supportedTools: ["function-calling"],
          supportedMediaTypes: ["text"]
        }
      ],
      defaultModel: "command-r",
      status: {
        available: process.env.COHERE_API_KEY ? true : false,
        lastChecked: new Date(),
        uptime: 99.7,
        responseTime: 420,
        errorRate: 0.15,
      },
      capabilities: ["text-generation", "code-generation", "reasoning", "rag-optimization"],
      credentialRequirements: ["apiKey"]
    };

    this.providers.set("cohere", cohereConfig);
    
    // Create adapter for Cohere
    const cohereAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Cohere error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.text || response.generations) {
          const content = response.text || (response.generations && response.generations[0]?.text) || "";
          
          return {
            __typename: "ReactorChatMessage",
            id: response.id || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: content,
            timestamp: new Date(),
            tool_calls: response.tool_calls || null
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => {
        return {
          __typename: "ReactorInitiateSSE",
          sessionId: stream.id || Math.random().toString(36).substring(2, 15),
          endpoint: "/api/reactor/stream/cohere",
          token: stream.token,
          status: "ready",
          expiry: new Date(Date.now() + 3600 * 1000), // 1 hour
        };
      }
    };

    this.adapters.set("cohere", cohereAdapter);
  }

  async getProviders(): Promise<any[]> {
    return Array.from(this.providers.values());
  }

  async getProvider(providerId: string): Promise<any> {
    return this.providers.get(providerId);
  }

  async registerProvider(providerConfig: any): Promise<any> {
    this.providers.set(providerConfig.id, providerConfig);
    return providerConfig;
  }

  async updateProviderStatus(providerId: string, status: any): Promise<any> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    
    provider.status = {
      ...provider.status,
      ...status,
      lastChecked: new Date()
    };
    
    this.providers.set(providerId, provider);
    return provider;
  }

  async getAdapter(providerId: string): Promise<any> {
    return this.adapters.get(providerId);
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorProviderService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string = "Service for managing AI provider integrations";
  tags?: string[] = ["ai", "llm", "provider"];
  nameSpace: string = "reactor";
  name: string = "Reactor Provider Service";
  version: string = "1.0.0";
}

export default ReactorProviderService;
