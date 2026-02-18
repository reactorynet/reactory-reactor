import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorCapabilityService, IReactorProviderService } from "../../types/service.types";

/**
 * Service for processing and routing generic AI requests
 */
@service({
  id: "reactor.ReactorMessageProcessingService@1.0.0",
  name: "Reactor Message Processing Service",
  nameSpace: "reactor",
  description: "Service for processing and routing generic AI requests",
  serviceType: "ai",
  dependencies: [
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" },
    { id: "reactor.ReactorCapabilityService@1.0.0", alias: "capabilityService" },
    { id: "reactor.OpenAIService@1.0.0", alias: "openaiService" }
  ],
})
class ReactorMessageProcessingService {
  context: Reactory.Server.IReactoryContext;
  private providerService: IReactorProviderService;
  private capabilityService: IReactorCapabilityService;
  private openaiService: any;

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  setCapabilityService(service: IReactorCapabilityService) {
    this.capabilityService = service;
  }

  setOpenAIService(service: any) {
    this.openaiService = service;
  }

  /**
   * Process a generic AI request with advanced routing and capabilities
   */
  async processGenericRequest(template: any, parameters: any, chatSessionId?: string): Promise<any> {
    try {
      // 1. Apply template parameters
      const processedMessage = this.applyTemplateParameters(template.messageTemplate, parameters);
      
      // 2. Apply processing options
      const processedRequest = await this.applyProcessingOptions(processedMessage, template.processingOptions);
      
      // 3. Route to appropriate provider
      const provider = await this.capabilityService.routeRequest(
        processedRequest, 
        template.routing
      );
      
      // 4. Get provider adapter
      const adapter = await this.providerService.getAdapter(provider.id);
      
      // 5. Execute request with appropriate service based on provider
      let result;
      if (provider.id === 'openai') {
        result = await this.openaiService.chat({
          message: processedRequest,
          chatSessionId,
          personaId: parameters?.personaId
        });
      } else {
        throw new Error(`Provider ${provider.id} not implemented`);
      }
      
      // 6. Adapt the response
      return adapter.adaptResponse(result);
    } catch (error) {
      this.context.error(`Error processing generic request: ${error.message}`, { error });
      return {
        __typename: "ReactorErrorResponse",
        code: "PROCESSING_ERROR",
        message: error.message || "Unknown error processing request",
        details: error,
        timestamp: new Date(),
        recoverable: false,
        suggestion: "Try simplifying your request or check your parameters"
      };
    }
  }

  /**
   * Apply parameters to a message template
   */
  private applyTemplateParameters(template: string, parameters: any): string {
    if (!parameters) return template;
    
    let result = template;
    for (const [key, value] of Object.entries(parameters)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }
    return result;
  }

  /**
   * Apply processing options to a message
   */
  private async applyProcessingOptions(message: string, options: any): Promise<string> {
    if (!options) return message;
    
    let processedMessage = message;
    
    // Apply token limit if specified
    if (options.tokenLimit) {
      processedMessage = this.truncateToTokenLimit(processedMessage, options.tokenLimit);
    }
    
    // Filter sensitive information if enabled
    if (options.filterSensitiveInfo) {
      processedMessage = this.filterSensitiveInfo(processedMessage);
    }
    
    // Optimize prompt if enabled
    if (options.optimizePrompt) {
      processedMessage = this.optimizePrompt(processedMessage);
    }
    
    return processedMessage;
  }

  /**
   * Basic implementation of token limiting
   */
  private truncateToTokenLimit(message: string, limit: number): string {
    // Very basic approximation - in a real implementation use a proper tokenizer
    const approxTokens = message.split(/\s+/).length;
    if (approxTokens <= limit) return message;
    
    // Simple truncation - in production use a proper tokenizer
    const words = message.split(/\s+/);
    return words.slice(0, limit).join(' ') + '...';
  }

  /**
   * Filter potentially sensitive information
   */
  private filterSensitiveInfo(message: string): string {
    // Basic implementation - replace with more sophisticated PII detection
    const patterns = [
      { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN REMOVED]' }, // SSN
      { regex: /\b\d{16}\b/g, replacement: '[CREDIT CARD REMOVED]' }, // Credit card
      { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL REMOVED]' } // Email
    ];
    
    let result = message;
    patterns.forEach(pattern => {
      result = result.replace(pattern.regex, pattern.replacement);
    });
    
    return result;
  }

  /**
   * Optimize a prompt for better results
   */
  private optimizePrompt(message: string): string {
    // Basic implementation - in production use more sophisticated prompt engineering
    if (!message.trim().endsWith('.') && !message.trim().endsWith('?') && !message.trim().endsWith('!')) {
      message = message.trim() + '.';
    }
    
    return message;
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorMessageProcessingService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string = "Service for processing and routing generic AI requests";
  tags?: string[] = ["ai", "llm", "message", "processing"];
  nameSpace: string = "reactor";
  name: string = "Reactor Message Processing Service";
  version: string = "1.0.0";
}

export default ReactorMessageProcessingService;
