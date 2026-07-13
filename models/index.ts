import { ReactoryPersonaComponentRegistryEntry } from "../ai/persona/reactor";
import { BookTutorPersonaComponentRegistryEntry } from '../ai/persona/booktutor';
import { ClaudePersonaComponentRegistryEntry } from '../ai/persona/claude';
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
import MCPRegistryModel from './MCPRegistry';
import MCPInstalledConnectorModel from './MCPInstalledConnector';

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


export default [
  ReactoryPersonaComponentRegistryEntry,
  ReactorNodeModelComponentRegistryEntry,
  ReactorNodeMetricTypeModelComponentRegistryEntry,
  ReactorNodeCategoryModelComponentRegistryEntry,
  ReactorNodeLinkModelComponentRegistryEntry,
  BookTutorPersonaComponentRegistryEntry,
  ClaudePersonaComponentRegistryEntry,
  DataAnalyticsPersonaComponentRegistryEntry,
  InfrastructurePersonaComponentRegistryEntry,
  MCPRegistryModelComponentRegistryEntry,
  MCPInstalledConnectorModelComponentRegistryEntry,
  SecurityPersonaComponentRegistryEntry,
  WorkflowWillPersonaComponentRegistryEntry,
];