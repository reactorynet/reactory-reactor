import { DataSource } from 'typeorm';
import Reactory from '@reactorynet/reactory-core';
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
import ReactoryAiProvider from './ReactoryAiProvider';
import ReactoryAiModel from './ReactoryAiModel';
import ReactorConversationMessage from './ReactorConversationMessage';
import seedAiProviders from './seedAiProviders';

const {
  REACTORY_POSTGRES_HOST,
  REACTORY_POSTGRES_PORT,
  REACTORY_POSTGRES_USER,
  REACTORY_POSTGRES_PASSWORD,
  REACTORY_POSTGRES_DB,
  POSTGRES_DB_HOST,
  POSTGRES_DB_PORT,
  POSTGRES_USER,
  POSTGRES_PASSWORD,
  POSTGRES_DB,
  REACTOR_POSTGRES_SYNCHRONIZE,
  NODE_ENV,
} = process.env;

const synchronize = REACTOR_POSTGRES_SYNCHRONIZE !== undefined
  ? REACTOR_POSTGRES_SYNCHRONIZE === "true"
  : NODE_ENV !== "production";

export const ReactorPostgresDataSource = new DataSource({
  type: "postgres",
  host: REACTORY_POSTGRES_HOST || POSTGRES_DB_HOST || "localhost",
  port: parseInt(REACTORY_POSTGRES_PORT || POSTGRES_DB_PORT || "5432", 10),
  username: REACTORY_POSTGRES_USER || POSTGRES_USER || "reactory",
  password: REACTORY_POSTGRES_PASSWORD || POSTGRES_PASSWORD || "reactory",
  database: REACTORY_POSTGRES_DB || POSTGRES_DB || "reactory",
  synchronize,
  entities: [
    ReactoryAiProvider,
    ReactoryAiModel,
    ReactorConversationMessage,
  ],
});

/**
 * Initializes the Reactor PostgreSQL DataSource and seeds baseline providers if empty.
 */
export const initializeReactorDataSource = async (
  context?: Reactory.Server.IReactoryContext
): Promise<boolean> => {
  const log = (msg: string) => {
    if (context?.info) context.info(msg);
  };

  if (ReactorPostgresDataSource.isInitialized === true) {
    return true;
  }

  await ReactorPostgresDataSource.initialize();
  if (synchronize === true) {
    await ReactorPostgresDataSource.synchronize();
  }
  log(`Reactor PostgreSQL DataSource initialized (${ReactorPostgresDataSource.options.database}, synchronize: ${synchronize})`);

  // Verify and seed baseline providers from providers.yaml if not already present
  try {
    const stats = await seedAiProviders(ReactorPostgresDataSource, false);
    if (context?.info) {
      context.info(`Reactor AI Providers verified: ${stats.providersCount} providers, ${stats.modelsCount} models in PostgreSQL.`);
    }
  } catch (seedErr) {
    if (context?.warn) {
      context.warn(`Failed to seed AI providers: ${(seedErr as Error)?.message}`);
    }
  }

  return true;
};

export const ReactorPostgresDataSourceComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorPostgresDataSource> = {
  nameSpace: 'reactor',
  name: 'ReactorPostgresDataSource',
  version: '1.0.0',
  description: 'PostgreSQL DataSource backing Reactory AI Providers and Models',
  stem: 'postgres',
  tags: ['postgres', 'reactor', 'ai', 'providers'],
  component: ReactorPostgresDataSource,
  domain: Reactory.ComponentDomain.model,
  overwrite: false,
  onStartup: async (context: Reactory.Server.IReactoryContext) => {
    await initializeReactorDataSource(context);
  },
};

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
  ReactoryAiProvider,
  ReactoryAiModel,
  ReactorConversationMessage,
  seedAiProviders,
};

export default [
  ReactorPostgresDataSourceComponentRegistryEntry,
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
