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

  private capabilityDescriptions: Record<string, { name: string; description: string; parameters?: any[] }> = {
    "text-generation": {
      name: "Text Generation",
      description: "Generate natural language text and responses",
      parameters: [
        { name: "temperature", type: "float", required: false, defaultValue: 0.7, description: "Controls randomness of output" },
        { name: "max_tokens", type: "integer", required: false, defaultValue: 1000, description: "Maximum tokens to generate" }
      ]
    },
    "code-generation": {
      name: "Code Generation",
      description: "Generate, review, and refactor programming code",
      parameters: [
        { name: "language", type: "string", required: false, defaultValue: "typescript", description: "Programming language to generate" }
      ]
    },
    "image-generation": {
      name: "Image Generation",
      description: "Generate images based on prompts",
      parameters: [
        { name: "size", type: "string", required: false, defaultValue: "1024x1024", description: "Size of generated image" }
      ]
    },
    "image-understanding": {
      name: "Image Understanding",
      description: "Analyze and describe input images and visual content"
    },
    "speech-to-text": {
      name: "Speech to Text",
      description: "Transcribe audio streams and files into text"
    },
    "reasoning": {
      name: "Reasoning & Extended Thinking",
      description: "Perform multi-step analytical reasoning and thinking"
    },
    "structured-output": {
      name: "Structured Output",
      description: "Constrain model responses to strict JSON Schema definitions"
    }
  };

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  private getProviderService(): IReactorProviderService | undefined {
    if (this.providerService) return this.providerService;
    if (this.context?.getService) {
      try {
        this.providerService = this.context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
      } catch {
        // Fall back
      }
    }
    return this.providerService;
  }

  async getCapabilities(): Promise<any[]> {
    const providerSvc = this.getProviderService();
    if (!providerSvc) {
      return Array.from(this.capabilities.values());
    }

    const providers = await providerSvc.getProviders();
    const capMap = new Map<string, { id: string; name: string; description: string; providers: Set<string>; models: Set<string>; parameters: any[] }>();

    for (const provider of providers) {
      const pCaps = provider.capabilities || [];
      for (const capId of pCaps) {
        if (!capMap.has(capId)) {
          const meta = this.capabilityDescriptions[capId] || {
            name: capId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            description: `Capability: ${capId}`
          };
          capMap.set(capId, {
            id: capId,
            name: meta.name,
            description: meta.description,
            providers: new Set(),
            models: new Set(),
            parameters: meta.parameters || []
          });
        }
        const capObj = capMap.get(capId)!;
        capObj.providers.add(provider.id);
      }

      for (const model of provider.models || []) {
        const mCaps = model.capabilities || [];
        for (const capId of mCaps) {
          if (!capMap.has(capId)) {
            const meta = this.capabilityDescriptions[capId] || {
              name: capId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
              description: `Capability: ${capId}`
            };
            capMap.set(capId, {
              id: capId,
              name: meta.name,
              description: meta.description,
              providers: new Set(),
              models: new Set(),
              parameters: meta.parameters || []
            });
          }
          const capObj = capMap.get(capId)!;
          capObj.providers.add(provider.id);
          capObj.models.add(model.id);
        }
      }
    }

    return Array.from(capMap.values()).map(c => ({
      ...c,
      providers: Array.from(c.providers),
      models: Array.from(c.models)
    }));
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
