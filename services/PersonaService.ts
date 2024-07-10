import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators";
import {
  IAIPersona,
  IAIPersonaProviderService,
} from "@reactory/server-modules/reactor/types/service.types";

export type PersonaProviderProps = {};
export type PersonaProviderContext = Reactory.Server.IReactoryContext & {};

@service({
  id: "reactor.AIPersonaProvider@1.0.0",
  nameSpace: "reactor",
  name: "AIPersonaProvider",
  version: "1.0.0",
  description: "Service for managing AI Personas",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryModelRegistry@1.0.0", alias: "modelRegistry" },    
  ],
})
export default class AIPersonaProvider
  implements Reactory.Service.IReactoryDefaultService, IAIPersonaProviderService
{

  description?: string = "Service for managing AI Personas";
  tags?: string[] = ["ai", "persona"];
  nameSpace: string = "reactor";
  name: string = "AIPersonaProvider";
  version: string = "1.0.0";

  context: Reactory.Server.IReactoryContext;

  private modelRegistry: Reactory.Service.TReactoryModelRegistryService;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: PersonaProviderContext
  ) {
    
  }

  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}${includeVersion ?  `@${this.version}` : ''}`;
  }

  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }
  setExecutionContext(context: Reactory.Server.IReactoryContext): void {
    this.context = context
  }

  async onStartup(): Promise<void> {
    return Promise.resolve();
  }

  async listPersonas(): Promise<IAIPersona[]> {
    // collect all 
    let personas: IAIPersona[] = await this.modelRegistry.getModels<IAIPersona>({
      name: "*aipersona",
    });
    
    return personas;
  }

  async getPersona(id: string): Promise<IAIPersona> {
    const personas: IAIPersona[] = await this.listPersonas();
    const persona = personas.find((persona) => persona.id === id);
    if (!persona) {
      throw new Error(`Persona with id ${id} not found`);
    }
    return persona;
  }

  setModelRegistry(modelRegistry: Reactory.Service.TReactoryModelRegistryService): void { 
    this.modelRegistry = modelRegistry;
  }
  
  async createPersona(params: IAIPersona): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }

  async updatePersona(params: IAIPersona): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }

  async deletePersona(id: string): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }
}
