import "reflect-metadata";
import { DataSource } from "typeorm";
import { REACTOR_ENTITIES, REACTOR_MIGRATIONS } from "./schema";
import { typeormPostgresOptions } from "../../../../database/connectionOptions";

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
  ...typeormPostgresOptions(),
  synchronize: false,
  migrationsRun: false,
  entities: REACTOR_ENTITIES,
  ...REACTOR_MIGRATIONS,
});
