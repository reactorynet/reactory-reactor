import { ingest } from "@reactory/server-core/utils/io"
import appearance from './appearance';
import { IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactory/reactory-core";

const REACTOR_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const REACTOR_FEATURES_TEXT = ingest(require.resolve('./features.md'));

export const ReactoryPersona: IAIPersona = {
  id: "ReactorAIPersona",
  name: "Reactor",
  persona: ingest(require.resolve('./persona.md')),
  features: ingest(require.resolve('./features.md')),
  appearance,
  modelId: process.env.OPENAI_DEFAULT_MODEL_ID ||  "grok-2-latest",
  providerId: process.env.REACTOR_AI_PERSONA_PROVIDER_ID || "xai",
  defaultGreeting: "Hello, I am Reactor, your general purpose AI assistant. How may I assist you today?",
  prompts: {
    "system": { 
      content: `${REACTOR_PERSONA_TEXT}\n${REACTOR_FEATURES_TEXT}`,
      role: "system",
    },
  },
  config: {
    apiKey: process.env.OPENAI_API_KEY,
    apiBaseURL: process.env.OPENAI_API_BASE_URL || "https://api.x.ai/v1",
  },
  tools: [],
  macros: [
    {
      nameSpace: "reactor-macros",
      name: "Greeting",
      description: "A macro that provides a canned greeting from the user.",
      version: "1.0.0",
      component: "greet",
      runat: "client",
      roles: ['ANON', 'USER'],
      alias: 'greet',
    }
  ],
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