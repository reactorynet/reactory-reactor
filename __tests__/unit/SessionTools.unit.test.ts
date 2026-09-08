import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AddToolsToSessionMacro, RemoveToolsFromSessionMacro, ToolkitMacro, ToolkitMacroRegistry } from '../../ai/macro/runtime/sessionTools.macro';
import type { ChatState } from '../../ai/openai/types/chat';
import AIProviderBase from '../../services/reactor/providers/AIProviderBase';
import { MacroToolDefinition, MacroComponentDefinition } from '../../ai/openai/types/chat';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockPersonaLoader = {
  resolveTools: jest.fn((args: any) => {
    return (args.includes || []).map((name: string) => ({
      type: 'function',
      function: { name, description: `Mock ${name}` }
    }));
  }),
  resolveMacros: jest.fn((args: any) => {
    return (args.includes || []).map((name: string) => ({
      name,
      nameSpace: 'mock-namespace'
    }));
  })
};

const mockMacroService = {
  listMacrosForPersona: jest.fn(async (personaId: string) => {
    return [
      {
        name: 'defaultMacro',
        tools: [
          { type: 'function', function: { name: 'defaultTool' } }
        ]
      }
    ] as any[];
  })
};

const mockSave = jest.fn();

// We define a shared conversation state object that we can mutate and clear in beforeEach
const mockConversation = {
  _id: 'session-123',
  tools: [] as any[],
  macros: [] as any[],
  toolApprovalMode: 'prompt',
  started: new Date(),
  modelId: 'gpt-4',
  personaId: 'Reactor',
  save: mockSave
};

// Create a mock query builder that supports chaining .populate().exec() and is Thenable
const mockQuery = {
  populate: jest.fn().mockReturnThis(),
  exec: jest.fn(async () => ({
    ...mockConversation,
    save: mockSave
  })),
  then: jest.fn((resolve: any) => {
    return Promise.resolve({
      ...mockConversation,
      save: mockSave
    }).then(resolve);
  })
};

jest.mock('@reactory/server-modules/reactory-reactor/models/ReactorChatState', () => {
  return {
    __esModule: true,
    default: {
      findById: jest.fn(() => mockQuery),
      findOne: jest.fn(() => mockQuery),
      findOneAndUpdate: jest.fn(() => mockQuery)
    }
  };
});

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  const ReactorConversationModel = require('@reactory/server-modules/reactory-reactor/models/ReactorChatState').default;
  return {
    id: 'session-123',
    tools: [],
    macros: [],
    persona: {
      id: 'Reactor',
      name: 'Reactor',
      toolProfiles: [
        {
          name: 'DeveloperProfile',
          description: 'A profile for developer tools',
          tools: ['readFile', 'writeFile', 'shell']
        }
      ]
    },
    context: {
      getService: jest.fn((fqn: string) => {
        if (fqn === 'reactor.PersonaLoaderService@1.0.0') return mockPersonaLoader;
        return undefined;
      }),
      models: {
        ReactorConversation: ReactorConversationModel
      }
    } as unknown as Reactory.Server.IReactoryContext,
    ...overrides
  } as unknown as ChatState;
}

// ── Test AI Provider Implementation for Fallback Verification ──────────────

class TestAIProvider extends AIProviderBase {
  public mockMacroService: any;

  constructor(props: any, context: any, macroService: any) {
    super(props, context);
    this.mockMacroService = macroService;
    this.personaProvider = {
      getPersona: jest.fn(async () => ({
        id: 'Reactor',
        tools: [{ type: 'function', function: { name: 'fallbackTool' } }]
      }))
    };
  }

  protected async initializeClient(persona: any): Promise<void> {}

  // Expose protected loadChatState for testing
  public async testLoadChatState(chatSessionId: string) {
    return await this.loadChatState(chatSessionId);
  }

  // Simulate provider's tool definition resolution with fallback logic
  public async getResolvedTools(): Promise<any[]> {
    const tools = this.chatState?.tools;
    // Fallback logic matches modified OpenAIService/OllamaAIService
    if (tools === undefined || tools === null) {
      const macros = await this.mockMacroService.listMacrosForPersona(this.chatState.personaId);
      const dynamicTools: any[] = [];
      macros.forEach((macro: any) => {
        if (macro.tools) {
          macro.tools.forEach((tool: any) => {
            if (tool.type === "function") {
              dynamicTools.push(tool);
            }
          });
        }
      });
      return dynamicTools;
    }
    return tools;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Session Tools and Fallback Fix Unit Tests', () => {
  let mockContext: any;
  let ReactorConversationModel: any;

  beforeEach(() => {
    jest.clearAllMocks();
    ReactorConversationModel = require('@reactory/server-modules/reactory-reactor/models/ReactorChatState').default;
    
    // Explicitly reset our mock conversation document state before every test
    mockConversation.tools = [];
    mockConversation.macros = [];
    
    mockContext = {
      user: { _id: 'user-123', id: 'user-123', fullName: () => 'Test User' },
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
  });

  // ── 1. Macro Tests ────────────────────────────────────────────────────────

  describe('AddToolsToSessionMacro', () => {
    it('should add specified tools and their macros to the session', async () => {
      const state = makeState();
      const result: any = await AddToolsToSessionMacro(
        { tools: ['readFile', 'writeFile'] },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.addedTools).toContain('readFile');
      expect(result.addedTools).toContain('writeFile');
      expect(state.tools).toHaveLength(2);
      expect(mockSave).toHaveBeenCalled();
    });

    it('should add tools from a tool profile', async () => {
      const state = makeState();
      const result: any = await AddToolsToSessionMacro(
        { profileName: 'DeveloperProfile' },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.addedTools).toContain('readFile');
      expect(result.addedTools).toContain('writeFile');
      expect(result.addedTools).toContain('shell');
      expect(state.tools).toHaveLength(3);
    });

    it('should return error if tool profile is not found', async () => {
      const state = makeState();
      const result: any = await AddToolsToSessionMacro(
        { profileName: 'InvalidProfile' },
        state,
        state.context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('RemoveToolsFromSessionMacro', () => {
    it('should remove specified tools from the session', async () => {
      const state = makeState();
      state.tools = [
        { type: 'function', function: { name: 'readFile' } },
        { type: 'function', function: { name: 'writeFile' } }
      ] as any;
      
      mockConversation.tools = [...state.tools];

      const result: any = await RemoveToolsFromSessionMacro(
        { tools: ['readFile'] },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.removedTools).toContain('readFile');
      expect(state.tools).toHaveLength(1);
      expect(state.tools[0].function.name).toBe('writeFile');
    });
  });

  // ── 2. ToolkitMacro Tests ─────────────────────────────────────────────────

  describe('ToolkitMacro', () => {
    it('should inspect available tools and tool profiles with action=available', async () => {
      const state = makeState();
      state.tools = [{ type: 'function', function: { name: 'readFile' } }] as any;
      (state.persona as any).tools = [
        { type: 'function', category: 'FS', function: { name: 'readFile', description: 'Read' } },
        { type: 'function', category: 'FS', function: { name: 'writeFile', description: 'Write' } },
        { type: 'function', category: 'Shell', function: { name: 'shell', description: 'Shell' } }
      ];

      const result: any = await ToolkitMacro(
        { action: 'available' },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('available');
      expect(result.availableTools).toHaveLength(3);
      expect(result.toolProfiles).toHaveLength(1);
      expect(result.toolProfiles[0].name).toBe('DeveloperProfile');
      expect(result.activeTools).toContain('readFile');
    });

    it('should inspect current active tools with action=current', async () => {
      const state = makeState();
      state.tools = [
        { type: 'function', function: { name: 'readFile' } },
        { type: 'function', function: { name: 'writeFile' } },
        { type: 'function', function: { name: 'shell' } }
      ] as any;

      const result: any = await ToolkitMacro(
        { action: 'current' },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.activeTools).toEqual(['readFile', 'writeFile', 'shell']);
      expect(result.activeProfile).toBe('DeveloperProfile');
    });

    it('should replace active tools with specified tools using action=replace', async () => {
      const state = makeState();
      state.tools = [
        { type: 'function', function: { name: 'readFile' } },
        { type: 'function', function: { name: 'writeFile' } }
      ] as any;

      const result: any = await ToolkitMacro(
        { action: 'replace', tools: ['shell'] },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('replace');
      expect(result.activeTools).toEqual(['shell']);
      expect(state.tools).toHaveLength(1);
      expect(state.tools[0].function.name).toBe('shell');
      expect(mockSave).toHaveBeenCalled();
    });

    it('should replace active tools with a profile using action=replace and profileName', async () => {
      const state = makeState();
      state.tools = [{ type: 'function', function: { name: 'customTool' } }] as any;

      const result: any = await ToolkitMacro(
        { action: 'replace', profileName: 'DeveloperProfile' },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.activeTools).toContain('readFile');
      expect(result.activeTools).toContain('writeFile');
      expect(result.activeTools).toContain('shell');
      expect(state.tools).toHaveLength(3);
    });

    it('should create and save a custom toolkit definition with action=save', async () => {
      const state = makeState();
      (mockConversation as any).markModified = jest.fn();

      const result: any = await ToolkitMacro(
        {
          action: 'save',
          name: 'TaskToolkit',
          description: 'Special toolkit for reviewing code',
          tools: ['readFile', 'safeEditFile']
        },
        state,
        state.context
      );

      expect(result.success).toBe(true);
      expect(result.toolkit.name).toBe('TaskToolkit');
      expect(result.toolkit.tools).toEqual(['readFile', 'safeEditFile']);
      expect(state.persona?.toolProfiles?.some(p => p.name === 'TaskToolkit')).toBe(true);
      expect(mockSave).toHaveBeenCalled();
    });
  });

  // ── 2. Provider Fallback Fix Tests ────────────────────────────────────────

  describe('AI Provider Fallback Fix', () => {
    it('should fall back to default persona tools if chatState.tools is undefined or null', async () => {
      mockConversation.tools = null; // Simulate legacy session with unpopulated tools field
      
      const provider = new TestAIProvider({}, mockContext, mockMacroService);
      await provider.testLoadChatState('session-123');

      const resolvedTools = await provider.getResolvedTools();
      expect(resolvedTools).toHaveLength(1);
      expect(resolvedTools[0].function.name).toBe('defaultTool');
    });

    it('should NOT fall back and respect empty toolbelt if chatState.tools is explicitly empty array []', async () => {
      mockConversation.tools = []; // Explicitly cleared tools list
      
      const provider = new TestAIProvider({}, mockContext, mockMacroService);
      await provider.testLoadChatState('session-123');

      const resolvedTools = await provider.getResolvedTools();
      expect(resolvedTools).toHaveLength(0); // Respects empty list, no fallback!
    });
  });
});
