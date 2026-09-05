import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, MacroToolDefinition } from "../../../types/chat";
import PersonaLoaderService from "../../persona/loader/persona-loader";
import ReactorConversationModel from "../../../models/ReactorChatState";
import amq from "../../../../../amq";

export interface ToolkitProps {
  action: 'available' | 'current' | 'add' | 'remove' | 'replace' | 'save';
  tools?: string[];
  profileName?: string;
  name?: string;
  description?: string;
}

export const ToolkitMacro: Macro<unknown, ToolkitProps> = async (
  props: ToolkitProps,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  try {
    const { action = 'current', tools: toolNames = [], profileName, name: customName, description: customDescription } = props;

    // Resolve PersonaLoaderService defensively
    let personaLoader: PersonaLoaderService | null = null;
    if (context?.getService) {
      personaLoader = context.getService<PersonaLoaderService>("reactor.PersonaLoaderService@1.0.0");
    } else if (state?.context?.getService) {
      personaLoader = state.context.getService<PersonaLoaderService>("reactor.PersonaLoaderService@1.0.0");
    }

    // Resolve model defensively (handles unit test mocks on context.models as well as production direct imports)
    const ConversationModel = (context as any)?.models?.ReactorConversation 
      || (state?.context as any)?.models?.ReactorConversation 
      || ReactorConversationModel;

    // Helpers to resolve tools and macros safely with in-memory fallback
    const publishToolsChanged = (toolNames: string[]) => {
      try {
        if (amq) {
          if (typeof amq.raiseSystemEvent === 'function') {
            amq.raiseSystemEvent('reactor.tools.changed', {
              chatSessionId: state.id,
              tools: toolNames,
              timestamp: new Date().toISOString(),
            });
          }
          if (amq.$pub && typeof amq.$pub.def === 'function') {
            amq.$pub.def('reactor.tools.changed', {
              chatSessionId: state.id,
              tools: toolNames,
              timestamp: new Date().toISOString(),
            }, 'reactor');
            amq.$pub.def('tools.changed', {
              chatSessionId: state.id,
              tools: toolNames,
              timestamp: new Date().toISOString(),
            }, 'reactor');
          }
        }
      } catch (pubErr) {
        // ignore if amq publish fails
      }
    };

    const resolveToolsSafe = (names: string[]): any[] => {
      if (personaLoader) {
        try {
          const resolved = personaLoader.resolveTools({ includes: names });
          if (resolved && resolved.length > 0) return resolved;
        } catch (e) {
          // ignore and fallback
        }
      }
      const pool = [...(state.persona?.tools || []), ...(state.tools || [])];
      return pool.filter((t: any) => {
        const name = t.function?.name || t.name;
        return name && names.includes(name);
      });
    };

    const resolveMacrosSafe = (names: string[]): any[] => {
      if (personaLoader) {
        try {
          const resolved = personaLoader.resolveMacros({ includes: names });
          if (resolved && resolved.length > 0) return resolved;
        } catch (e) {
          // ignore and fallback
        }
      }
      const pool = [...(state.persona?.macros || []), ...(state.macros || [])];
      return pool.filter((m: any) => {
        if (Array.isArray(m?.tools) && m.tools.length > 0) {
          return m.tools.some((t: any) => names.includes(t.function?.name || t.name));
        }
        return names.includes(m.alias || m.name);
      });
    };

    // ── 1. Action: "available" ──────────────────────────────────────────────
    if (action === 'available') {
      const personaTools = state.persona?.tools || [];
      const catalogToolSummaries = personaTools.map((t: any) => ({
        name: t.function?.name || t.name,
        category: t.category || (t.function as any)?.category || 'General',
        description: t.function?.description || t.description || '',
      })).filter((t: any) => Boolean(t.name));

      const toolProfiles = (state.persona?.toolProfiles || []).map((p: any) => ({
        name: p.name,
        description: p.description || '',
        tools: p.tools || [],
        count: (p.tools || []).length,
      }));

      const activeToolNames = (state.tools || []).map((t: any) => t.function?.name || t.name).filter(Boolean);

      const instructions = [
        `## Available Tools & Toolkits\n`,
        `### Pre-defined Toolkits (Toolbelts):`,
        ...toolProfiles.map((p: any) => `- **${p.name}** (${p.count} tools): ${p.description}`),
        `\n### Currently Active Tools in Session (${activeToolNames.length}):`,
        ...activeToolNames.map((t: string) => `- \`${t}\``),
        `\n### Total Available Catalog Tools: ${catalogToolSummaries.length}`,
        `\nUse \`toolkit(action="replace", profileName="...")\` to switch to a toolbelt, or \`toolkit(action="add"|"remove"|"replace", tools=[...])\` to customize your tool selection.`
      ].join('\n');

      return {
        success: true,
        action: 'available',
        activeTools: activeToolNames,
        toolProfiles,
        availableTools: catalogToolSummaries,
        totalAvailable: catalogToolSummaries.length,
        instructions,
      };
    }

    // ── 2. Action: "current" ────────────────────────────────────────────────
    if (action === 'current') {
      const activeToolNames = (state.tools || []).map((t: any) => t.function?.name || t.name).filter(Boolean);
      const matchingProfile = (state.persona?.toolProfiles || []).find((p: any) => {
        const pTools = p.tools || [];
        return pTools.length === activeToolNames.length && pTools.every((t: string) => activeToolNames.includes(t));
      });

      const instructions = [
        `## Current Session Toolkit\n`,
        `**Active Tools Count**: ${activeToolNames.length}`,
        matchingProfile ? `**Active Profile**: ${matchingProfile.name}` : `**Active Profile**: Custom Selection`,
        `\n### Active Tools:`,
        ...activeToolNames.map((t: string) => `- \`${t}\``),
      ].join('\n');

      return {
        success: true,
        action: 'current',
        activeTools: activeToolNames,
        totalToolsCount: activeToolNames.length,
        activeProfile: matchingProfile?.name || 'Custom',
        instructions,
      };
    }

    // ── Database conversation lookup (optional: works in-memory if no database ID) ──
    let conversation: any = null;
    if (state.id && ConversationModel) {
      try {
        conversation = await ConversationModel.findById(state.id);
      } catch (findErr) {
        // Continue with in-memory state if database lookup fails
      }
    }

    // ── 3. Action: "add" ────────────────────────────────────────────────────
    if (action === 'add') {
      let finalToolNames = [...toolNames];

      if (profileName) {
        const profile = state.persona?.toolProfiles?.find(
          (p: any) => p.name.toLowerCase() === profileName.toLowerCase()
        );
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

      finalToolNames = Array.from(new Set(finalToolNames));

      const toolsToAdd = resolveToolsSafe(finalToolNames);
      const macrosToAdd = resolveMacrosSafe(finalToolNames);

      if (toolsToAdd.length === 0) {
        return {
          success: false,
          error: `None of the specified tools (${finalToolNames.join(", ")}) could be resolved from the registry.`,
          instructions: `## Failed to Add Tools\n\nSpecified tools could not be resolved from the registry.`
        };
      }

      const currentTools = conversation?.tools ? [...conversation.tools] : [...(state.tools || [])];
      const currentMacros = conversation?.macros ? [...conversation.macros] : [...(state.macros || [])];
      const addedToolsList: string[] = [];

      toolsToAdd.forEach((tool: any) => {
        const toolName = tool.function?.name || tool.name;
        const exists = currentTools.some((t: any) => (t.function?.name || t.name) === toolName);
        if (!exists) {
          currentTools.push(tool);
          addedToolsList.push(toolName);
        }
      });

      macrosToAdd.forEach((macro: any) => {
        const macroName = macro.name || macro.alias;
        const exists = currentMacros.some((m: any) => (m.name || m.alias) === macroName);
        if (!exists) {
          currentMacros.push(macro);
        }
      });

      if (conversation) {
        conversation.tools = currentTools;
        conversation.macros = currentMacros;
        await conversation.save();
      }

      state.tools = currentTools;
      state.macros = currentMacros;

      const activeNames = currentTools.map((t: any) => t.function?.name || t.name);
      publishToolsChanged(activeNames);

      return {
        success: true,
        action: 'add',
        addedTools: addedToolsList,
        totalToolsCount: currentTools.length,
        instructions: `## Tools Added Successfully\n\nSuccessfully added:\n${addedToolsList.map(t => `- **${t}**`).join("\n")}\n\nTotal enabled tools: **${currentTools.length}**.`
      };
    }

    // ── 4. Action: "remove" ─────────────────────────────────────────────────
    if (action === 'remove') {
      if (!toolNames || toolNames.length === 0) {
        return {
          success: false,
          error: "No tools specified to remove.",
          instructions: `## Failed to Remove Tools\n\nNo tools specified.`
        };
      }

      const currentTools = conversation?.tools ? [...conversation.tools] : [...(state.tools || [])];
      const currentMacros = conversation?.macros ? [...conversation.macros] : [...(state.macros || [])];
      const removedToolsList: string[] = [];

      const updatedTools = currentTools.filter((tool: any) => {
        const name = tool.function?.name || tool.name;
        if (toolNames.includes(name)) {
          removedToolsList.push(name);
          return false;
        }
        return true;
      });

      const updatedMacros = currentMacros.filter((macro: any) => {
        if (macro.tools && macro.tools.length > 0) {
          return macro.tools.some((macroTool: any) =>
            updatedTools.some((t: any) => (t.function?.name || t.name) === (macroTool.function?.name || macroTool.name))
          );
        }
        return true;
      });

      if (conversation) {
        conversation.tools = updatedTools;
        conversation.macros = updatedMacros;
        await conversation.save();
      }

      state.tools = updatedTools;
      state.macros = updatedMacros;

      const activeNames = updatedTools.map((t: any) => t.function?.name || t.name);
      publishToolsChanged(activeNames);

      return {
        success: true,
        action: 'remove',
        removedTools: removedToolsList,
        totalToolsCount: updatedTools.length,
        instructions: `## Tools Removed Successfully\n\nSuccessfully removed:\n${removedToolsList.map(t => `- **${t}**`).join("\n")}\n\nTotal enabled tools: **${updatedTools.length}**.`
      };
    }

    // ── 5. Action: "replace" ────────────────────────────────────────────────
    if (action === 'replace') {
      let finalToolNames = [...toolNames];

      if (profileName) {
        const profile = state.persona?.toolProfiles?.find(
          (p: any) => p.name.toLowerCase() === profileName.toLowerCase()
        );
        if (!profile) {
          return {
            success: false,
            error: `Tool profile "${profileName}" not found on the persona definition.`,
            instructions: `## Failed to Replace Tools\n\nTool profile **${profileName}** was not found.`
          };
        }
        finalToolNames = [...profile.tools];
      }

      if (finalToolNames.length === 0) {
        return {
          success: false,
          error: "No tools or valid tool profile specified to replace with.",
          instructions: `## Failed to Replace Tools\n\nNo tools or valid tool profile specified.`
        };
      }

      finalToolNames = Array.from(new Set(finalToolNames));

      const toolsToSet = resolveToolsSafe(finalToolNames);
      const macrosToSet = resolveMacrosSafe(finalToolNames);

      if (conversation) {
        conversation.tools = toolsToSet;
        conversation.macros = macrosToSet;
        await conversation.save();
      }

      state.tools = toolsToSet;
      state.macros = macrosToSet;

      const activeNames = toolsToSet.map((t: any) => t.function?.name || t.name);
      publishToolsChanged(activeNames);

      return {
        success: true,
        action: 'replace',
        activeTools: activeNames,
        totalToolsCount: toolsToSet.length,
        profileName: profileName || null,
        instructions: `## Toolkit Replaced Successfully\n\nActive toolkit updated to **${toolsToSet.length}** tools${profileName ? ` from **${profileName}**` : ''}:\n${activeNames.map(t => `- **${t}**`).join("\n")}`
      };
    }

    // ── 6. Action: "save" ───────────────────────────────────────────────────
    if (action === 'save') {
      if (!customName) {
        return {
          success: false,
          error: "A 'name' is required to save a custom toolkit.",
          instructions: `## Failed to Save Toolkit\n\nPlease provide a \`name\` for the toolkit.`
        };
      }

      const finalTools = (toolNames && toolNames.length > 0)
        ? Array.from(new Set(toolNames))
        : (state.tools || []).map((t: any) => t.function?.name || t.name).filter(Boolean);

      if (finalTools.length === 0) {
        return {
          success: false,
          error: "Cannot save an empty toolkit. Specify 'tools' or enable tools first.",
          instructions: `## Failed to Save Toolkit\n\nToolkit has no tools.`
        };
      }

      const newProfile = {
        name: customName,
        description: customDescription || `Custom toolkit: ${customName} (${finalTools.length} tools)`,
        tools: finalTools,
      };

      if (!state.persona) {
        state.persona = {} as any;
      }
      if (!Array.isArray(state.persona.toolProfiles)) {
        state.persona.toolProfiles = [];
      }

      const existingIdx = state.persona.toolProfiles.findIndex(
        (p: any) => p.name.toLowerCase() === customName.toLowerCase()
      );
      if (existingIdx >= 0) {
        state.persona.toolProfiles[existingIdx] = newProfile;
      } else {
        state.persona.toolProfiles.push(newProfile);
      }

      // Persist to conversation metadata/vars if conversation is present
      if (conversation) {
        if (!conversation.vars) {
          conversation.vars = {};
        }
        const customProfiles = (conversation.vars as any).customToolProfiles || [];
        const customIdx = customProfiles.findIndex((p: any) => p.name.toLowerCase() === customName.toLowerCase());
        if (customIdx >= 0) {
          customProfiles[customIdx] = newProfile;
        } else {
          customProfiles.push(newProfile);
        }
        (conversation.vars as any).customToolProfiles = customProfiles;
        if (typeof conversation.markModified === 'function') {
          conversation.markModified('vars');
        }
        await conversation.save();
      }

      // Also store in state.vars so it's immediately accessible in memory
      if (!state.vars) {
        state.vars = {};
      }
      state.vars.customToolProfiles = state.persona.toolProfiles;

      publishToolsChanged(finalTools);

      return {
        success: true,
        action: 'save',
        toolkit: newProfile,
        instructions: `## Custom Toolkit Saved\n\nSuccessfully saved toolkit **${customName}** with ${finalTools.length} tools:\n${finalTools.map((t: string) => `- **${t}**`).join("\n")}`
      };
    }

    return {
      success: false,
      error: `Unsupported toolkit action: "${action}". Valid actions are: available, current, add, remove, replace, save.`,
      instructions: `## Invalid Action\n\nSupported actions: \`available\`, \`current\`, \`add\`, \`remove\`, \`replace\`, \`save\`.`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: errMsg,
      instructions: `## Toolkit Operation Failed\n\nError: ${errMsg}`
    };
  }
};

export const ToolkitMacroRegistry: MacroComponentDefinition<typeof ToolkitMacro> = {
  nameSpace: 'reactor-macros',
  name: 'toolkit',
  version: '1.0.0',
  alias: 'toolkit',
  component: ToolkitMacro,
  category: 'Runtime',
  description: `# toolkit macro
  Manage the agent's active tools and custom toolkits for the current session.

  ## Actions:
  - 'available': List all tools and pre-defined toolbelts available in the catalog.
  - 'current': Inspect currently active tools in the session.
  - 'add': Add tools or a named toolbelt to the session.
  - 'remove': Remove tools from the session.
  - 'replace': Replace active session tools entirely with a new selection or toolbelt.
  - 'save': Save a custom named toolkit for reuse.
  `,
  features: [
    {
      feature: 'toolkit',
      featureType: Reactory.FeatureType.function,
      action: ['manage', 'configure', 'select', 'list', 'add', 'remove', 'replace', 'save'],
      description: 'Manage agent toolkits and active tool selection.',
      stem: 'toolkit'
    }
  ],
  roles: ['USER'],
  stem: 'toolkit',
  tags: ['toolkit', 'toolbelt', 'tools', 'session', 'dynamic', 'runtime'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "toolkit",
      description: "Manage the agent's active tools and toolkits for the current session. Discover available catalog tools, inspect current tools, add/remove/replace tools to fit the current task, or save a custom toolkit.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["available", "current", "add", "remove", "replace", "save"],
            description: "Operation to perform: 'available' (list all catalog tools & toolbelts), 'current' (show active tools), 'add' (add tools to session), 'remove' (remove tools from session), 'replace' (replace active session tools entirely with new selection), 'save' (save a custom named toolkit)."
          },
          tools: {
            type: "array",
            description: "List of tool function names to add, remove, replace with, or include in a saved toolkit.",
            items: {
              type: "string"
            }
          },
          profileName: {
            type: "string",
            description: "Name of an existing pre-defined toolkit/toolbelt (used with 'add' or 'replace')."
          },
          name: {
            type: "string",
            description: "Name for a custom toolkit when using 'save'."
          },
          description: {
            type: "string",
            description: "Description for the custom toolkit when using 'save'."
          }
        },
        required: ["action"]
      }
    }
  }]
};

export interface AddToolsProps {
  tools?: string[];
  profileName?: string;
}

export const AddToolsToSessionMacro: Macro<unknown, AddToolsProps> = async (
  props: AddToolsProps,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  return ToolkitMacro({ action: 'add', ...props }, state, context);
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
  return ToolkitMacro({ action: 'remove', ...props }, state, context);
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
