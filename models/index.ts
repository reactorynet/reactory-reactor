import { ReactoryPersonaComponentRegistryEntry } from "../ai/persona/reactor";
import { BookTutorPersonaComponentRegistryEntry } from '../ai/persona/booktutor';
import { DataAnalyticsPersonaComponentRegistryEntry } from '../ai/persona/dataanalytics';
import { InfrastructurePersonaComponentRegistryEntry } from '../ai/persona/infrastructure';
import { SecurityPersonaComponentRegistryEntry } from '../ai/persona/security';
import { WorkflowWillPersonaComponentRegistryEntry } from '../ai/persona/workflowwill';
import {
  ReactorNodeModelComponentRegistryEntry,
  ReactorNodeMetricTypeModelComponentRegistryEntry,
  ReactorNodeCategoryModelComponentRegistryEntry
} from './ReactorGraphNode';
import { ReactorNodeLinkModelComponentRegistryEntry } from './ReactorNodeLink';
import { ReactorGraphPerspectiveModelComponentRegistryEntry } from './ReactorGraphPerspective';
import MCPRegistryModel from './MCPRegistry';
import MCPInstalledConnectorModel from './MCPInstalledConnector';
import ReactorAIUsageModel, { ReactorAIUsageModelComponentRegistryEntry } from './ReactorAIUsage';
import ReactorUserBudgetModel, { ReactorUserBudgetModelComponentRegistryEntry } from './ReactorUserBudget';

export const MCPRegistryModelComponentRegistryEntry = {
  nameSpace: 'reactory',
  name: 'MCPRegistry',
  version: '1.0.0',
  component: MCPRegistryModel,
};

export const MCPInstalledConnectorModelComponentRegistryEntry = {
  nameSpace: 'reactory',
  name: 'MCPInstalledConnector',
  version: '1.0.0',
  component: MCPInstalledConnectorModel,
};

export {
  ReactorAIUsageModel,
  ReactorAIUsageModelComponentRegistryEntry,
  ReactorUserBudgetModel,
  ReactorUserBudgetModelComponentRegistryEntry,
};

export default [
  ReactoryPersonaComponentRegistryEntry,
  ReactorNodeModelComponentRegistryEntry,
  ReactorNodeMetricTypeModelComponentRegistryEntry,
  ReactorNodeCategoryModelComponentRegistryEntry,
  ReactorNodeLinkModelComponentRegistryEntry,
  ReactorGraphPerspectiveModelComponentRegistryEntry,
  BookTutorPersonaComponentRegistryEntry,
  DataAnalyticsPersonaComponentRegistryEntry,
  InfrastructurePersonaComponentRegistryEntry,
  MCPRegistryModelComponentRegistryEntry,
  MCPInstalledConnectorModelComponentRegistryEntry,
  SecurityPersonaComponentRegistryEntry,
  WorkflowWillPersonaComponentRegistryEntry,
  ReactorAIUsageModelComponentRegistryEntry,
  ReactorUserBudgetModelComponentRegistryEntry,
];
