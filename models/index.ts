import { ReactoryPersonaComponentRegistryEntry } from "../ai/persona/reactor";
import { BookTutorPersonaComponentRegistryEntry } from '../ai/persona/booktutor';
import { ClaudePersonaComponentRegistryEntry } from '../ai/persona/claude';
import {
  ReactorNodeModelComponentRegistryEntry,
  ReactorNodeMetricTypeModelComponentRegistryEntry,
  ReactorNodeCategoryModelComponentRegistryEntry
} from './ReactorGraphNode';
export default [
  ReactoryPersonaComponentRegistryEntry,
  ReactorNodeModelComponentRegistryEntry,
  ReactorNodeMetricTypeModelComponentRegistryEntry,
  ReactorNodeCategoryModelComponentRegistryEntry,
  BookTutorPersonaComponentRegistryEntry,
  ClaudePersonaComponentRegistryEntry,
]