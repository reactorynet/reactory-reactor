import { service } from "@reactory/server-core/application/decorators/service";
import { 
  AIStreamingCapabilities,
  AIStreamingEvent,
  IOpenAIServiceProps
} from '../../../types/service.types';
import { 
  AIChatParams, 
  AIAudioChatParams 
} from '../../../types/model.types';
import OpenAIStreamingService from './OpenAIStreamingService';

/**
 * Interface for xAI service properties
 * Extends OpenAI props since xAI uses the same API specification
 */
export interface IXAIServiceProps extends IOpenAIServiceProps {
  /**
   * The xAI API key to use for the service
   */
  apiKey: string;
  /**
   * The xAI API endpoint (defaults to https://api.x.ai/v1)
   */
  apiEndpoint: string;
  /**
   * The xAI API base URL 
   */
  apiBaseURL?: string;
}

@service({
  id: "reactor.xAIStreamingService@1.0.0",
  name: "xAI/Grok Streaming Service",
  nameSpace: "reactor",
  description: "xAI/Grok Service with streaming capabilities for real-time AI interactions using Grok models",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
  ],
})
class XAIStreamingService extends OpenAIStreamingService {
  
  version: string = '1.0.0';
  tags: string[] = ['streaming', 'ai', 'xai', 'grok'];
  
  constructor(props: IXAIServiceProps, context: Reactory.Server.IReactoryContext) {
    // Configure for xAI endpoint and API key
    const xaiProps: IOpenAIServiceProps = {
      ...props,
      apiKey: props.apiKey || process.env.XAI_API_KEY || '',
      apiBaseURL: props.apiBaseURL || props.apiEndpoint || process.env.XAI_API_URL || 'https://api.x.ai/v1',
      apiEndpoint: props.apiEndpoint || process.env.XAI_API_URL || 'https://api.x.ai/v1',
      apiVersion: props.apiVersion || 'v1',
      // xAI doesn't use organization ID like OpenAI
      apiOrganizationId: undefined
    };
    
    super(xaiProps, context);
  }

  /**
   * Get streaming capabilities for xAI/Grok provider
   * xAI supports similar capabilities to OpenAI since it uses the same API spec
   */
  async getStreamingCapabilities(): Promise<AIStreamingCapabilities> {
    return {
      supportsTokenStreaming: true,
      supportsToolStreaming: true,
      supportsFunctionStreaming: true,
      maxConcurrentStreams: 10,
      supportedFormats: ['json', 'text', 'sse']
    };
  }

  /**
   * Stream chat completion with xAI/Grok models
   * Inherits the full implementation from OpenAIStreamingService since xAI uses the same API
   */
  async* chatStream(params: AIChatParams): AsyncIterable<AIStreamingEvent> {
    try {
      // Set default model to Grok if not specified
      const xaiParams = {
        ...params,
        model: params.model || this.getDefaultGrokModel()
      };

      // Use the parent OpenAI streaming implementation
      // This works because xAI API is compatible with OpenAI API specification
      yield* super.chatStream(xaiParams);

    } catch (error) {
      // Enhanced error handling for xAI-specific issues
      const enhancedError = this.enhanceXAIError(error);
      yield this.createXAIStreamingEvent('error', {
        error: enhancedError,
        timestamp: new Date()
      });
    }
  }

  /**
   * Stream audio chat with xAI (placeholder - follows OpenAI pattern)
   */
  async* chatAudioStream(params: AIAudioChatParams): AsyncIterable<AIStreamingEvent> {
    yield this.createXAIStreamingEvent('error', {
      error: new Error('Audio streaming not yet implemented for xAI/Grok'),
      timestamp: new Date()
    });
  }

  /**
   * Create a streaming event with xAI-specific context
   */
  private createXAIStreamingEvent(type: AIStreamingEvent['type'], data: any): AIStreamingEvent {
    return {
      type,
      data: {
        ...data,
        provider: 'xai',
        model: data.model || this.getDefaultGrokModel()
      },
      timestamp: new Date(),
      sessionId: this.chatState?.sseSession || 'unknown'
    };
  }

  /**
   * Get the default Grok model to use
   */
  private getDefaultGrokModel(): string {
    // Use the latest Grok model as default
    return process.env.XAI_DEFAULT_MODEL || 'grok-beta';
  }

  /**
   * Enhance error messages with xAI-specific context
   */
  private enhanceXAIError(error: any): Error {
    if (error instanceof Error) {
      // Add xAI context to error messages
      if (error.message.includes('401')) {
        return new Error(`xAI authentication failed: ${error.message}. Please check your XAI_API_KEY environment variable.`);
      }
      
      if (error.message.includes('quota') || error.message.includes('rate limit')) {
        return new Error(`xAI rate limit exceeded: ${error.message}. Please check your xAI account limits.`);
      }
      
      if (error.message.includes('model')) {
        return new Error(`xAI model error: ${error.message}. Available models: grok-beta, grok-vision-beta`);
      }
      
      // General xAI error context
      return new Error(`xAI/Grok API error: ${error.message}`);
    }
    
    return new Error(`xAI/Grok streaming error: ${String(error)}`);
  }

  /**
   * Override onStart to provide xAI-specific logging
   */
  async onStart(): Promise<void> {
    const apiKey = this.props.apiKey || process.env.XAI_API_KEY;
    const apiEndpoint = this.props.apiBaseURL;
    
    if (!apiKey) {
      this.context.warn('xAI API key not configured. Set XAI_API_KEY environment variable.');
    }
    
    this.context.log(`xAI Streaming Service started with endpoint: ${apiEndpoint}`, 'info');
    this.context.log('xAI Streaming Service ready for Grok model interactions', 'info');
  }

  toString(includeVersion?: boolean): string {
    return `XAIStreamingService${includeVersion ? "@1.0.0" : ""}`;
  }
}

export default XAIStreamingService;
