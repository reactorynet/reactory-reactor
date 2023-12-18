import { ingest } from "@reactory/server-core/utils/io"
import appearance from './appearance';
import { IAIPersona } from "@reactory/server-modules/reactor/types/service.types";
import { FeatureType } from "@reactory/reactory-core";

export const ReactoryPersona: IAIPersona = {
  id: "ReactorAIPersona",
  name: "Reactor",
  persona: ingest(require.resolve('./persona.md')),
  features: ingest(require.resolve('./features.md')),
  appearance
}

export const ReactoryPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "ReactoryAIPersona",
  description: "Reactory AI Persona",
  version: "1.0.0",
  component: ReactoryPersona,
  features: [
    { 
      feature: "appearance",
      description: "Reactory AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Reactory AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Reactory AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}