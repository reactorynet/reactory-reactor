import Reactory from "@reactory/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { StateMacroProps } from './types';

// A macro that provides information about the current chat state
export const StateMacro: Macro<unknown, StateMacroProps> = async (
  props: StateMacroProps,
  state: ChatState): Promise<unknown> => {
    try {
      // clone the state to avoid modifying the original
      
      const safe_state = { 
        vars: state.vars,
        id: state.id,
        host: state.host,
        user: {
          id: state.user.id,
          email: (state.user as any).loggedIn?.user?.email,
          name: (state.user as any).loggedIn?.user?.name,
          lastName: (state.user as any).loggedIn?.user?.lastName,
        },
        botId: state.personaId,
        persona: state.persona,
        modelId: state.modelId,
        created: state.created,
        updated: state.updated,
      };

      return {
        result: safe_state,
        success: true,
        operation: 'get',
        chatState: safe_state,
        sessionId: state.id,
        variablesCount: Object.keys(state.vars || {}).length
      };
    } catch (err) {
      return {
        error: `Error in state macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
        success: false
      };
    }
};

export const StateMacroRegistry: MacroComponentDefinition<typeof StateMacro> = {
  nameSpace: 'reactor-macros',
  name: 'state',
  version: '1.0.0',
  component: StateMacro,
  description: `# state macro
  Use this macro to access the current chat state

  ## Usage
  @state - returns a JSON object with the current chat state
  `,
  features: [
    {
      feature: 'get',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'fetch', 'retrieve'],
      description: 'Operation that gets the current chat state.',
      stem: 'get'
    }
  ],
  roles: ['USER'],
  stem: 'state',
  tags: ['state', 'chat', 'session', 'context'],
  tools: [{
    type: "function",
    function: {
      name: "state",
      description: "Access the current chat state object",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }]
} 