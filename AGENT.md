# reactory-reactor -- Server Module Agent Context

## What Is This Module

The AI brain of the Reactory platform. This module provides multi-provider AI conversation services (OpenAI, Anthropic, Google GenAI, AWS Bedrock), streaming chat, document chunking for RAG, project management, system graph analysis, MCP SDK integration, and AI persona management.

- **Module ID**: `reactory-reactor`
- **Namespace**: `reactory`
- **FQN**: `reactory.reactory-reactor@1.0.0`
- **Version**: `1.0.0`
- **Priority**: `1`
- **License**: Commercial
- **Package**: `@reactory/reactor` v1.1.0

## Directory Structure

```
reactory-reactor/
  index.ts                # ReactoryModuleDefinition entry point
  graphql/
    resolvers/            # GraphQL resolvers for AI operations
    schema/               # GraphQL type definitions
    directives/           # Custom directives
  services/               # AI service implementations
  models/                 # Data models (ChatState, GraphNode, Project)
  forms/                  # 18 form subdirectories (Chat, Graph, Projects, etc.)
  cli/                    # CLI commands
  middleware/             # Request middleware
  ai/                     # AI provider implementations
  hooks/                  # Lifecycle hooks
  helpers/                # Utility helpers
  utils/                  # Utility functions
  mcpsdk/                 # Model Context Protocol SDK integration
  workflow/               # Workflow definitions
  docs/                   # Module documentation
  certs/                  # Client certificates
  __tests__/              # Test files
```

## Key Services

| Service | Purpose |
|---|---|
| `ReactorConversationService` | AI conversation management |
| `StreamingConversationService` | Real-time streaming AI conversations |
| `ReactorProviderService` | AI provider orchestration and selection |
| `ReactorCapabilityService` | AI capability management |
| `ReactorMessageProcessingService` | Message processing pipeline |
| `ReactorMacroProviderService` | Macro/command provider for AI operations |
| `AIPersonaProvider` | AI persona management and selection |
| `DocumentChunkingService` | Document chunking for RAG (Retrieval-Augmented Generation) |
| `ReactorProjectService` | AI-assisted project management |
| `SystemGraphManager` | System graph analysis and visualization |

## AI Provider Implementations

| Provider | Integration |
|---|---|
| `OpenAIService` | OpenAI GPT models |
| `AnthropicService` | Anthropic Claude models |
| `GoogleAIService` | Google GenAI models |
| `AWSBedrockService` | AWS Bedrock models |
| `ReactorMacroService` | Built-in macro execution engine |

## Dependencies (package.json)

- `openai` -- OpenAI SDK
- `@anthropic-ai/sdk` -- Anthropic SDK
- `@google/genai` -- Google GenAI SDK
- `@aws-sdk/client-bedrock` -- AWS Bedrock SDK
- `@modelcontextprotocol/sdk` -- MCP SDK

## Form Schemas (18 categories)

Chat, Graph, Project, ProjectDeployments, ProjectDocumentation, ProjectHistory, ProjectIncidents, ProjectInfoPanel, ProjectMetrics, ProjectOverview, Projects, ProjectSecurity, ProjectTeamEdit, ProjectTeamPanel, ServiceCatalogue, Widgets.

## Models

- `ReactorChatState` -- Chat session state and history
- `ReactorGraphNode` -- System graph node definitions
- `ReactorProject` -- AI project definitions and metadata

## Client Plugin

The module serves a `ReactorWebClient` plugin that provides the web-based chat interface and project management UI.

## Testing

From the host server checkout, against the module's natural mount (`src/modules/reactory-reactor`):

```bash
$REACTORY_SERVER/bin/jest.sh reactory local --testPathPattern=reactor
```

From an AI worktree (`src/modules/reactory-worktrees/ai-<ref>`) that command runs the PRIMARY
checkout, not your work, and a bare `jest` run against the worktree fails at load with
`Cannot find module '../../../database/...'` / `Tests: 0 total`. The worktree sits one directory
level deeper than the natural mount, so the module's relative imports resolve one level short.

Use the shipped harness instead - it is the only supported worktree recipe:

```bash
node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats
node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
```

Exit **0** means every collected suite loaded and every test passed; exit **1** means a suite
failed to load, a test failed, or the wrapper could not run Jest. The wrapper adds `--forceExit`
when the inherited server config enables `detectOpenHandles`, because this repository has async
work that survives teardown and would otherwise turn a green run red. Record the command, its exit
code and the counts.

From a repository that does not ship `scripts/ai/`, invoke the copy in the server tree with
`--module-root <this worktree>` (one copy serves any module).

Do not hand-roll a Jest config and do not rewrite imports to work around the depth. Rationale,
both controls and troubleshooting: [docs/ai-worktree-testing.md](docs/ai-worktree-testing.md).
