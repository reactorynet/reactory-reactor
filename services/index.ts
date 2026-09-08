import OpenAIService from "./reactor/providers/OpenAIService";
import GoogleAIService from "./reactor/providers/GoogleAIService";
import AnthropicService from "./reactor/providers/AnthropicService";
import OllamaAIService from "./reactor/providers/OllamaAIService";
import PersonaService from "./reactor/AIPersonaProvider";
import ReactorConversationService from "./reactor/ReactorConversationService";
import ReactorCapabilityService from "./reactor/ReactorCapabilityService";
import ReactorMessageProcessingService from "./reactor/ReactorMessageProcessingService";
import ReactorProviderService from "./reactor/ReactorProviderService";
import ReactorAIUsageService from "./reactor/ReactorAIUsageService";
import SystemGraphManager from "./SystemGraphManager";
import ReactorProjectService from './ReactorProjectService';
import ReactorMacroService from "./reactor/providers/ReactorMacroService";
import { 
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor,
  PythonProjectProcessor,
  BackStageProjectProcessor,
  FileProjectProcessor,
  MarkdownProjectProcessor
} from './SystemGraphProjectProviders';
import JiraGraphProvider from "./ReactorGraphProviders/Jira/JiraGraphProvider";
import DatabaseGraphProvider from "./ReactorGraphProviders/Database/DatabaseGraphProvider";
import DocumentChunkingService from "./reactor/DocumentChunkingService";
import { StreamingSessionManager } from "./reactor/StreamingSessionManager";
import { StreamingTransportManager } from "./reactor/StreamingTransportManager";
import { ShellSessionManager } from "./reactor/ShellSessionManager";
import MCPRegistryService from "./mcp/MCPRegistryService";
import ReactorPlaywrightService from "./playwright/ReactorPlaywrightService";
import PersonaLoaderService from "@reactory/server-modules/reactory-reactor/ai/persona/loader/persona-loader";

export default [
  ReactorMacroService,
  PersonaLoaderService,
  ReactorConversationService,
  ReactorCapabilityService,
  ReactorMessageProcessingService,
  ReactorProviderService,
  ReactorAIUsageService,
  OpenAIService,
  PersonaService,
  GoogleAIService,
  AnthropicService,
  OllamaAIService,
  ReactorProjectService,
  SystemGraphManager,
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor,
  PythonProjectProcessor,
  BackStageProjectProcessor,
  FileProjectProcessor,
  JiraGraphProvider,
  DatabaseGraphProvider,
  DocumentChunkingService,
  MCPRegistryService,
  StreamingSessionManager,
  StreamingTransportManager,
  ShellSessionManager,
  ReactorPlaywrightService,
  MarkdownProjectProcessor
];
