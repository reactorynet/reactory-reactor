import OpenAIService from "./reactor/providers/OpenAIService";
import GoogleAIService from "./reactor/providers/GoogleAIService";
import PersonaService from "./reactor/AIPersonaProvider";
import ReactorConversationService from "./reactor/ReactorConversationService";
import ReactorCapabilityService from "./reactor/ReactorCapabilityService";
import ReactorMessageProcessingService from "./reactor/ReactorMessageProcessingService";
import ReactorProviderService from "./reactor/ReactorProviderService";
import SystemGraphManager from "./SystemGraphManager";
import ReactorProjectService from './ReactorProjectService';
import ReactorMacroService from "./reactor/providers/ReactorMacroService";
import { 
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
} from './SystemGraphProjectProviders';
export default [
  ReactorMacroService,
  ReactorConversationService,
  ReactorCapabilityService,
  ReactorMessageProcessingService,
  ReactorProviderService,
  OpenAIService,
  PersonaService,
  GoogleAIService,
  ReactorProjectService,
  SystemGraphManager,
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
];