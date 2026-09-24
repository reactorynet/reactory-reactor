import { DataSource } from 'typeorm';
import { registerTenantDataSource } from "@reactory/server-core/database/tenant/TenantRepository";
import { typeormPostgresOptions } from "@reactory/server-core/database/connectionOptions";
import { REACTOR_ENTITIES, REACTOR_MIGRATIONS } from "../migrations/typeorm/schema";
import { prepareSchemaOrExit, resolveSynchronize } from "@reactory/server-core/database/migrationGovernance";
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
import ReactorAiFailure from './ReactorAiFailure';
import seedAiProviders from './seedAiProviders';

const {
  REACTOR_POSTGRES_SYNCHRONIZE,
  NODE_ENV,
} = process.env;

// Development-only unless REACTOR_POSTGRES_SYNCHRONIZE says otherwise; see
// src/database/migrationGovernance.ts.
const synchronize = resolveSynchronize(REACTOR_POSTGRES_SYNCHRONIZE, NODE_ENV);

export const ReactorPostgresDataSource = new DataSource({
  type: "postgres",
  // Host, credentials and TLS: src/database/connectionOptions.ts (WP-B4).
  ...typeormPostgresOptions(),
  synchronize: false,
  entities: REACTOR_ENTITIES,
  ...REACTOR_MIGRATIONS,
});

// Lets getTenantRepository(context, Entity) find this DataSource (WP-B2).
registerTenantDataSource(ReactorPostgresDataSource);

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
  await prepareSchemaOrExit(ReactorPostgresDataSource, { label: 'reactory-reactor Postgres', synchronize, log });
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
