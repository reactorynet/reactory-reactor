import Reactory from "@reactorynet/reactory-core";
import { getConnectionFactory } from "@reactory/server-core/database";
import { ReactoryDatabaseVariant } from "@reactory/server-core/database/types";
import { IIntrospectionAdapter, SqlRunner } from "./types";
import { PostgresIntrospectionAdapter } from "./postgres";
import { MySqlIntrospectionAdapter } from "./mysql";
import { MsSqlIntrospectionAdapter } from "./mssql";
import { DatabricksIntrospectionAdapter } from "./databricks";

/**
 * Builds a read-only SqlRunner over the core connection factories
 * (`src/database/*`). Credentials are resolved by the factory from the active
 * partner's connection settings (invariant P2 — the provider never sees them).
 */
export const makeSqlRunner = async (
  variant: ReactoryDatabaseVariant,
  connectionId: string,
  context: Reactory.Server.IReactoryContext
): Promise<SqlRunner> => {
  const factory = getConnectionFactory(variant);
  switch (variant) {
    case "postgres": {
      const sql: any = await factory.getConnection(connectionId, context);
      return async (statement: string) => (await sql.unsafe(statement)) as any[];
    }
    case "mysql": {
      const pool: any = await factory.getConnection(connectionId, context);
      return (statement: string) =>
        new Promise<any[]>((resolve, reject) => {
          pool.query(statement, (err: Error, rows: any[]) =>
            err ? reject(err) : resolve(rows || [])
          );
        });
    }
    case "mssql": {
      const pool: any = await factory.getConnection(connectionId, context);
      return async (statement: string) => {
        const result = await pool.request().query(statement);
        return result?.recordset || [];
      };
    }
    case "databricks": {
      const databricks: any = factory;
      return async (statement: string) =>
        (await databricks.executeQuery(connectionId, statement, context)) || [];
    }
    default:
      throw new Error(
        `DatabaseGraphProvider does not support variant '${variant}' (mongo structure inference is a future session)`
      );
  }
};

/** Builds the variant's introspection adapter over a SqlRunner. */
export const makeIntrospectionAdapter = (
  variant: ReactoryDatabaseVariant,
  run: SqlRunner
): IIntrospectionAdapter => {
  switch (variant) {
    case "postgres":
      return new PostgresIntrospectionAdapter(run);
    case "mysql":
      return new MySqlIntrospectionAdapter(run);
    case "mssql":
      return new MsSqlIntrospectionAdapter(run);
    case "databricks":
      return new DatabricksIntrospectionAdapter(run);
    default:
      throw new Error(`No introspection adapter for variant '${variant}'`);
  }
};
