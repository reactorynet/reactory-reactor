import { ReactoryPersonaComponentRegistryEntry } from "../ai/persona/reactor";
import { BookTutorPersonaComponentRegistryEntry } from '../ai/persona/booktutor';
import { ClaudePersonaComponentRegistryEntry } from '../ai/persona/claude';
import { DataAnalyticsPersonaComponentRegistryEntry } from '../ai/persona/dataanalytics';
import { InfrastructurePersonaComponentRegistryEntry } from '../ai/persona/infrastructure';
import { SecurityPersonaComponentRegistryEntry } from '../ai/persona/security';
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
  DataAnalyticsPersonaComponentRegistryEntry,
  InfrastructurePersonaComponentRegistryEntry,
  SecurityPersonaComponentRegistryEntry,
];