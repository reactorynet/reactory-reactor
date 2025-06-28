import { ingest } from "@reactory/server-core/utils/io"
import appearance from './appearance';
import { IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactory/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/openai/chat/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";

const REACTOR_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const REACTOR_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const REACTOR_TOOLS: MacroToolDefinition[] = [];
const REACTOR_MACROS: MacroComponentDefinition<any>[] = [];
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function") {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
        REACTOR_TOOLS.push(t);
      }
    });
  }
});

// Add the macro tools to the tools array
MacroRegistry.forEach(m => {
  const macro = {
    ...m,
    runat: m.runat ?? "server",
  };
  REACTOR_MACROS.push(macro);
});


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
  tools: REACTOR_TOOLS,
  macros: REACTOR_MACROS,
}

export const ReactoryPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "ReactoryAIPersona",
  description: `Reactor AI Persona. General Purpose AI Assistant focussed on Reactory and Reactor.
  This persona is designed to assist users with a wide range of tasks, including but not limited to:
  - Answering questions about Reactory and Reactor
  - Providing information about Reactory and Reactor features
  - Assisting with Reactory and Reactor development
  - Offering guidance on best practices for using Reactory and Reactor
  - Helping users navigate the Reactory and Reactor ecosystem
  - Providing support for Reactory and Reactor-related issues
  - Offering insights and tips for optimizing Reactory and Reactor usage
  - Assisting with troubleshooting and debugging Reactory and Reactor applications
  - Providing recommendations for Reactory and Reactor tools and resources`,
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