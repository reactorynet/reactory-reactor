import OpenAIService from "./OpenAIService";
import PersonaService from "./PersonaService";
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