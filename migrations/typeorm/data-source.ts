import "reflect-metadata";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../../models/ReactorConversationMessage";

/**
 * Migration-only DataSource for the reactory-reactor module.
 *
 * The runtime DataSource (`models/index.ts` -> `ReactorPostgresDataSource`) is
 * entity-only and relies on `synchronize` in development. Migrations are the
 * only sanctioned way to change the schema in production, and TypeORM's CLI
 * needs a DataSource that lists them, so it lives here.
 *
 * Without this file `bin/migrate-typeorm.sh` skips the module entirely — it
 * no-ops when a module has no `migrations/typeorm/data-source.ts`.
 *
 * `synchronize` is deliberately false: a migration runner must never mutate the
 * schema implicitly.
 */
export default new DataSource({
  type: "postgres",
  host: process.env.REACTORY_POSTGRES_HOST || process.env.POSTGRES_DB_HOST || "localhost",
  port: parseInt(process.env.REACTORY_POSTGRES_PORT || process.env.POSTGRES_DB_PORT || "5432", 10),
  username: process.env.REACTORY_POSTGRES_USER || process.env.POSTGRES_USER || "reactory",
  password: process.env.REACTORY_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || "reactory",
  database: process.env.REACTORY_POSTGRES_DB || process.env.POSTGRES_DB || "reactory",
  synchronize: false,
  migrationsRun: false,
  entities: [ReactorConversationMessage],
  migrations: [__dirname + "/[0-9]*-*.ts", __dirname + "/[0-9]*-*.js"],
  migrationsTableName: "reactory_migrations_reactory_reactor",
});
