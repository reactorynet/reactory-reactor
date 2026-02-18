import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorCapabilityService, IReactorProviderService } from "../../types/service.types";

/**
 * Service for handling AI capability discovery and routing
 */
@service({
  id: "reactor.ReactorCapabilityService@1.0.0",
  name: "Reactor Capability Service",
  nameSpace: "reactor",
  description: "Service for managing AI capabilities and request routing",
  serviceType: "ai",
  dependencies: [
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" }
  ],
})
class ReactorCapabilityService implements IReactorCapabilityService {
  context: Reactory.Server.IReactoryContext;
  private capabilities: Map<string, any> = new Map();
  private providerService: IReactorProviderService;

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.initialize();
  }

  private async initialize() {
    // Register capabilities
    this.capabilities.set("text-generation", {
      id: "text-generation",
      name: "Text Generation",
      description: "Generate text based on prompts",
      providers: ["openai", "xai", "anthropic", "google", "cohere"],
      models: ["gpt-4", "gpt-3.5-turbo", "claude-2", "bard", "cohere"],
      parameters: [
        {
          name: "temperature",
          type: "float",
          required: false,
          defaultValue: 0.7,
          description: "Controls randomness of output"
        },
        {
          name: "max_tokens",
          type: "integer",
          required: false,
          defaultValue: 1000,
          description: "Maximum tokens to generate"
        }
      ]
    });

    this.capabilities.set("code-generation", {
      id: "code-generation",
      name: "Code Generation",
      description: "Generate code based on specifications",
      providers: ["openai", "xai"],
      models: ["gpt-4", "gpt-3.5-turbo"],
      parameters: [
        {
          name: "language",
          type: "string",
          required: false,
          defaultValue: "javascript",
          description: "Programming language to generate"
        }
      ]
    });

    this.capabilities.set("image-generation", {
      id: "image-generation",
      name: "Image Generation",
      description: "Generate images based on prompts",
      providers: ["openai"],
      models: ["dall-e-3"],
      parameters: [
        {
          name: "size",
          type: "string",
          required: false,
          defaultValue: "1024x1024",
          description: "Size of generated image"
        }
      ]
    });
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  async getCapabilities(): Promise<any[]> {
    return Array.from(this.capabilities.values());
  }

  async getProvidersForCapability(capabilityId: string): Promise<any[]> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      return [];
    }

    const providers = await this.providerService.getProviders();
    return providers.filter(provider => 
      capability.providers.includes(provider.id)
    );
  }

  async routeRequest(request: any, routingConfig: any): Promise<any> {
    const { preferredProvider, requiredCapabilities, fallbackProviders } = routingConfig;
    
    // If preferred provider is specified and supports all required capabilities, use it
    if (preferredProvider) {
      const provider = await this.providerService.getProvider(preferredProvider);
      const hasAllCapabilities = requiredCapabilities.every((cap: string) => 
        provider.capabilities.includes(cap)
      );
      
      if (hasAllCapabilities && provider.status.available) {
        return provider;
      }
    }
    
    // Find providers that support all required capabilities
    const providers = await this.providerService.getProviders();
    const eligibleProviders = providers.filter(provider => 
      provider.status.available && 
      requiredCapabilities.every((cap: string) => provider.capabilities.includes(cap))
    );
    
    if (eligibleProviders.length === 0) {
      throw new Error("No eligible providers found for required capabilities");
    }
    
    // Sort based on priority criteria
    if (routingConfig.prioritizePerformance) {
      eligibleProviders.sort((a, b) => a.status.responseTime - b.status.responseTime);
    } else if (routingConfig.prioritizeCost) {
      // Simple cost model, could be more sophisticated
      eligibleProviders.sort((a, b) => {
        const modelA = a.models.find((m: any) => m.id === a.defaultModel);
        const modelB = b.models.find((m: any) => m.id === b.defaultModel);
        return (modelA?.costPerToken || 0) - (modelB?.costPerToken || 0);
      });
    }
    
    return eligibleProviders[0];
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorCapabilityService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string = "Service for managing AI capabilities and request routing";
  tags?: string[] = ["ai", "llm", "routing", "capabilities"];
  nameSpace: string = "reactor";
  name: string = "Reactor Capability Service";
  version: string = "1.0.0";
}

export default ReactorCapabilityService;
