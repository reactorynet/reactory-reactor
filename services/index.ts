import OpenAIService from "./reactor/providers/OpenAIService";
import PersonaService from "./reactor/AIPersonaProvider";
import ReactorConversationService from "./reactor/ReactorConversationService";
import ReactorCapabilityService from "./reactor/ReactorCapabilityService";
import ReactorMessageProcessingService from "./reactor/ReactorMessageProcessingService";
import ReactorProviderService from "./reactor/ReactorProviderService";
import SystemGraphManager from "./SystemGraphManager";
import { 
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
} from './SystemGraphProjectProviders';
export default [
  ReactorConversationService,
  ReactorCapabilityService,
  ReactorMessageProcessingService,
  ReactorProviderService,
  OpenAIService,
  PersonaService,
  SystemGraphManager,
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
];