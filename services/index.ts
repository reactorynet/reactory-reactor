import OpenAIService from "./reactor/providers/OpenAIService";
import PersonaService from "./reactor/AIPersonaProvider";
import SystemGraphManager from "./SystemGraphManager";
import { 
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
} from './SystemGraphProjectProviders';
export default [
  OpenAIService,
  PersonaService,
  SystemGraphManager,
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor
];