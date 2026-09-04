import {
  ColumnMeta,
  FkMeta,
  IIntrospectionAdapter,
  RelationMeta,
  RoutineMeta,
  SqlRunner,
  lit,
} from "./types";

const SYSTEM_SCHEMAS = ["information_schema"];

/**
 * Databricks (Unity Catalog) structure reader over information_schema
 * (SELECT-only). Foreign keys are *informational* constraints in UC — present
 * when declared; workspaces without UC constraint metadata yield none (the
 * failure is caught and reported as an empty set).
 */
export class DatabricksIntrospectionAdapter implements IIntrospectionAdapter {
  constructor(private run: SqlRunner) {}

  async listSchemas(): Promise<string[]> {
    const rows = await this.run(
      `SELECT schema_name FROM information_schema.schemata ` +
        `WHERE schema_name NOT IN (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ")}) ORDER BY schema_name`
    );
    return rows.map((r) => r.schema_name);
  }

  async listRelations(schema: string): Promise<RelationMeta[]> {
    const rows = await this.run(
      `SELECT table_name, table_type, comment FROM information_schema.tables ` +
        `WHERE table_schema = '${lit(schema)}' ORDER BY table_name`
    );
    return rows.map((r) => ({
      schema,
      name: r.table_name,
      kind: String(r.table_type).toUpperCase() === "VIEW" ? "view" : "table",
      comment: r.comment || undefined,
    }));
  }

  async listColumns(schema: string): Promise<ColumnMeta[]> {
    const rows = await this.run(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, ` +
        `ordinal_position, comment FROM information_schema.columns ` +
        `WHERE table_schema = '${lit(schema)}' ORDER BY table_name, ordinal_position`
    );
    return rows.map((r) => ({
      schema,
      relation: r.table_name,
      name: r.column_name,
      dataType: r.data_type,
      nullable: String(r.is_nullable).toUpperCase() === "YES",
      default: r.column_default ?? null,
      ordinal: Number(r.ordinal_position),
      comment: r.comment || undefined,
    }));
  }

  async listForeignKeys(schema: string): Promise<FkMeta[]> {
    try {
      const rows = await this.run(
        `SELECT tc.constraint_name, kcu.table_schema AS src_schema, kcu.table_name AS src_table, ` +
          `kcu.column_name AS src_column, ccu.table_schema AS dst_schema, ` +
          `ccu.table_name AS dst_table, ccu.column_name AS dst_column ` +
          `FROM information_schema.table_constraints tc ` +
          `JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name ` +
          `JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name ` +
          `WHERE kcu.table_schema = '${lit(schema)}' AND tc.constraint_type = 'FOREIGN KEY'`
      );
      return rows.map((r) => ({
        constraintName: r.constraint_name,
        srcSchema: r.src_schema,
        srcTable: r.src_table,
        srcColumn: r.src_column,
        dstSchema: r.dst_schema,
        dstTable: r.dst_table,
        dstColumn: r.dst_column,
      }));
    } catch {
      // UC constraint views absent on this workspace — informational FKs unavailable.
      return [];
    }
  }

  async listRoutines(schema: string): Promise<RoutineMeta[]> {
    try {
      const rows = await this.run(
        `SELECT routine_name, routine_type, data_type FROM information_schema.routines ` +
          `WHERE routine_schema = '${lit(schema)}' ORDER BY routine_name`
      );
      return rows.map((r) => ({
        schema,
        name: r.routine_name,
        kind: String(r.routine_type || "function").toLowerCase(),
        returns: r.data_type,
      }));
    } catch {
      return [];
    }
  }
}
