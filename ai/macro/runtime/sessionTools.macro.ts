import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, MacroToolDefinition } from "../../../types/chat";
import PersonaLoaderService from "../../persona/loader/persona-loader";

export interface AddToolsProps {
  tools?: string[];
  profileName?: string;
}

export const AddToolsToSessionMacro: Macro<unknown, AddToolsProps> = async (
  props: AddToolsProps,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  try {
    const { tools: toolNames = [], profileName } = props;
    
    // Resolve PersonaLoaderService
    const personaLoader = context.getService<PersonaLoaderService>("reactor.PersonaLoaderService@1.0.0");
    if (!personaLoader) {
      throw new Error("PersonaLoaderService not found");
    }

    let finalToolNames = [...toolNames];

    // If profileName is specified, resolve the tools from the profile
    if (profileName) {
      // Find the profile in the persona's tool profiles
      const profile = state.persona?.toolProfiles?.find(p => p.name === profileName);
      if (!profile) {
        return {
          success: false,
          error: `Tool profile "${profileName}" not found on the persona definition.`,
          instructions: `## Failed to Add Tools\n\nTool profile **${profileName}** was not found.`
        };
      }
      finalToolNames.push(...profile.tools);
    }

    if (finalToolNames.length === 0) {
      return {
        success: false,
        error: "No tools or valid tool profile specified to add.",
        instructions: `## Failed to Add Tools\n\nNo tools or valid tool profile specified.`
      };
    }

    // De-duplicate finalToolNames
    finalToolNames = Array.from(new Set(finalToolNames));

    // Resolve tools from the registry
    const toolsToAdd = personaLoader.resolveTools({ includes: finalToolNames });
    const macrosToAdd = personaLoader.resolveMacros({ includes: finalToolNames });

    if (toolsToAdd.length === 0) {
      return {
        success: false,
        error: `None of the specified tools (${finalToolNames.join(", ")}) could be resolved from the registry.`,
        instructions: `## Failed to Add Tools\n\nSpecified tools could not be resolved from the registry.`
      };
    }

    // Load the conversation document to save changes
    const ReactorConversationModel = context.models.ReactorConversation;
    const conversation = await ReactorConversationModel.findById(state.id);
    if (!conversation) {
      throw new Error("Conversation session not found");
    }

    // Add tools to the conversation session
    const currentTools = conversation.tools || [];
    const currentMacros = conversation.macros || [];

    const addedToolsList: string[] = [];

    toolsToAdd.forEach(tool => {
      const exists = currentTools.some((t: any) => t.function?.name === tool.function?.name);
      if (!exists) {
        currentTools.push(tool);
        addedToolsList.push(tool.function?.name);
      }
    });

    macrosToAdd.forEach(macro => {
      const exists = currentMacros.some((m: any) => m.name === macro.name);
      if (!exists) {
        currentMacros.push(macro);
      }
    });

    conversation.tools = currentTools;
    conversation.macros = currentMacros;
    await conversation.save();

    // Also update the in-memory chat state so the current execution has access to them
    state.tools = currentTools;
    state.macros = currentMacros;

    return {
      success: true,
      addedTools: addedToolsList,
      totalToolsCount: currentTools.length,
      instructions: `## Tools Added Successfully\n\nSuccessfully added the following tools to the session:\n${addedToolsList.map(t => `- **${t}**`).join("\n")}\n\nTotal enabled tools: **${currentTools.length}**.`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: errMsg,
      instructions: `## Failed to Add Tools\n\nError: ${errMsg}`
    };
  }
};

export const AddToolsToSessionMacroRegistry: MacroComponentDefinition<typeof AddToolsToSessionMacro> = {
  nameSpace: 'reactor-macros',
  name: 'addToolsToSession',
  version: '1.0.0',
  alias: 'addToolsToSession',
  component: AddToolsToSessionMacro,
  category: 'Runtime',
  description: `# addToolsToSession macro
  Use this macro to dynamically add tools or a tool profile to the current chat session.

  ## Usage
  @addToolsToSession(tools: ["readFile", "writeFile"])
  `,
  features: [
    {
      feature: 'add',
      featureType: Reactory.FeatureType.function,
      action: ['add', 'enable', 'activate'],
      description: 'Operation that dynamically adds tools to the session.',
      stem: 'add'
    }
  ],
  roles: ['USER'],
  stem: 'addToolsToSession',
  tags: ['tools', 'session', 'dynamic', 'runtime'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "addToolsToSession",
      description: "Dynamically enable specific tools or a tool profile for the current chat session on demand.",
      parameters: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            description: "List of tool/function names to enable.",
            items: {
              type: "string"
            }
          },
          profileName: {
            type: "string",
            description: "Optional name of a pre-defined tool profile to enable."
          }
        },
        required: []
      }
    }
  }]
};

export interface RemoveToolsProps {
  tools: string[];
}

export const RemoveToolsFromSessionMacro: Macro<unknown, RemoveToolsProps> = async (
  props: RemoveToolsProps,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  try {
    const { tools: toolNames } = props;

    if (!toolNames || toolNames.length === 0) {
      return {
        success: false,
        error: "No tools specified to remove.",
        instructions: `## Failed to Remove Tools\n\nNo tools specified.`
      };
    }

    // Load the conversation document to save changes
    const ReactorConversationModel = context.models.ReactorConversation;
    const conversation = await ReactorConversationModel.findById(state.id);
    if (!conversation) {
      throw new Error("Conversation session not found");
    }

    const currentTools = conversation.tools || [];
    const currentMacros = conversation.macros || [];

    const removedToolsList: string[] = [];

    // Filter tools
    const updatedTools = currentTools.filter((tool: any) => {
      const name = tool.function?.name;
      if (toolNames.includes(name)) {
        removedToolsList.push(name);
        return false;
      }
      return true;
    });

    // Filter macros that no longer have any tools in updatedTools
    const updatedMacros = currentMacros.filter((macro: any) => {
      // If macro has tools, check if at least one of its tools remains in updatedTools
      if (macro.tools && macro.tools.length > 0) {
        return macro.tools.some((macroTool: any) => 
          updatedTools.some((t: any) => t.function?.name === macroTool.function?.name)
        );
      }
      return true;
    });

    conversation.tools = updatedTools;
    conversation.macros = updatedMacros;
    await conversation.save();

    // Also update the in-memory chat state
    state.tools = updatedTools;
    state.macros = updatedMacros;

    return {
      success: true,
      removedTools: removedToolsList,
      totalToolsCount: updatedTools.length,
      instructions: `## Tools Removed Successfully\n\nSuccessfully removed the following tools from the session:\n${removedToolsList.map(t => `- **${t}**`).join("\n")}\n\nTotal enabled tools: **${updatedTools.length}**.`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: errMsg,
      instructions: `## Failed to Remove Tools\n\nError: ${errMsg}`
    };
  }
};

export const RemoveToolsFromSessionMacroRegistry: MacroComponentDefinition<typeof RemoveToolsFromSessionMacro> = {
  nameSpace: 'reactor-macros',
  name: 'removeToolsFromSession',
  version: '1.0.0',
  alias: 'removeToolsFromSession',
  component: RemoveToolsFromSessionMacro,
  category: 'Runtime',
  description: `# removeToolsFromSession macro
  Use this macro to dynamically remove/disable tools from the current chat session.

  ## Usage
  @removeToolsFromSession(tools: ["readFile", "writeFile"])
  `,
  features: [
    {
      feature: 'remove',
      featureType: Reactory.FeatureType.function,
      action: ['remove', 'disable', 'deactivate'],
      description: 'Operation that dynamically removes tools from the session.',
      stem: 'remove'
    }
  ],
  roles: ['USER'],
  stem: 'removeToolsFromSession',
  tags: ['tools', 'session', 'dynamic', 'runtime'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "removeToolsFromSession",
      description: "Dynamically disable/remove specific tools from the current chat session to reduce context bloat.",
      parameters: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            description: "List of tool/function names to disable.",
            items: {
              type: "string"
            }
          }
        },
        required: ["tools"]
      }
    }
  }]
};
