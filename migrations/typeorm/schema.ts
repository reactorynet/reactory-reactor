/**
 * The reactory-reactor Postgres schema: entities and migration settings shared
 * by the runtime DataSource (models/index.ts) and the migration CLI DataSource
 * (data-source.ts). Relative imports only (loaded by the TypeORM CLI).
 */
import ReactoryAiProvider from "../../models/ReactoryAiProvider";
import ReactoryAiModel from "../../models/ReactoryAiModel";
import ReactoryAiModelPricing from "../../models/ReactoryAiModelPricing";
import ReactorConversationMessage from "../../models/ReactorConversationMessage";
import ReactorAiFailure from "../../models/ReactorAiFailure";

export const REACTOR_ENTITIES = [
  ReactoryAiProvider,
  ReactoryAiModel,
  ReactoryAiModelPricing,
  ReactorConversationMessage,
  ReactorAiFailure,
];

export const REACTOR_MIGRATIONS = {
  migrations: [__dirname + "/[0-9]*-*.ts", __dirname + "/[0-9]*-*.js"],
  migrationsTableName: "reactory_migrations_reactory_reactor",
};
