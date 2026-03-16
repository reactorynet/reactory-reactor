import Reactory from "@reactorynet/reactory-core";
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

      const varKeys = Object.keys(state.vars || {});
      const variablesCount = varKeys.length;

      return {
        result: safe_state,
        success: true,
        operation: 'get',
        chatState: safe_state,
        sessionId: state.id,
        variablesCount,
        instructions: `## Chat State Retrieved

Session **${state.id}** — ${variablesCount} variable${variablesCount !== 1 ? 's' : ''} stored.

### Session Information:
- **Session ID**: ${state.id}
- **Persona**: ${state.persona || 'default'}
- **Model**: ${state.modelId || 'unknown'}
- **User**: ${safe_state.user?.email || safe_state.user?.id || 'unknown'}
- **Created**: ${state.created || 'unknown'}
- **Variables Count**: ${variablesCount}

### Available Data:
- **chatState**: Full session state object (user, persona, model, host)
- **sessionId**: Current session identifier
- **variablesCount**: Number of stored variables
- **result.vars**: All stored variables${variablesCount > 0 ? ` (keys: ${varKeys.slice(0, 10).join(', ')}${varKeys.length > 10 ? '...' : ''})` : ''}

### Suggested Next Steps:
- Use \`var\` with a key name to get/set a specific variable
- Use \`modules\` to see available system modules
- Use \`env\` to check environment configuration`
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        error: `Error in state macro: ${errMsg}`,
        success: false,
        instructions: `## State Retrieval — Error\n\nFailed to retrieve chat state.\n\n### Error Details:\n- **Message**: ${errMsg}\n\n### Recovery Options:\n- Retry the \`state\` tool\n- Start a new chat session if state is corrupted`
      };
    }
};

export const StateMacroRegistry: MacroComponentDefinition<typeof StateMacro> = {
  nameSpace: 'reactor-macros',
  name: 'state',
  version: '1.0.0',
  alias: 'state',
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