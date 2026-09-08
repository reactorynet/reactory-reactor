import {
  ColumnMeta,
  FkMeta,
  IIntrospectionAdapter,
  RelationMeta,
  RoutineMeta,
  SqlRunner,
  ViewDepMeta,
  lit,
} from "./types";

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

/** PostgreSQL structure reader over information_schema (SELECT-only). */
export class PostgresIntrospectionAdapter implements IIntrospectionAdapter {
  constructor(private run: SqlRunner) {}

  async listSchemas(): Promise<string[]> {
    const rows = await this.run(
      `SELECT schema_name FROM information_schema.schemata ` +
        `WHERE schema_name NOT IN (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ")}) ` +
        `AND schema_name NOT LIKE 'pg_temp%' ORDER BY schema_name`
    );
    return rows.map((r) => r.schema_name);
  }

  async listRelations(schema: string): Promise<RelationMeta[]> {
    const rows = await this.run(
      `SELECT table_name, table_type FROM information_schema.tables ` +
        `WHERE table_schema = '${lit(schema)}' ORDER BY table_name`
    );
    return rows.map((r) => ({
      schema,
      name: r.table_name,
      kind: String(r.table_type).toUpperCase() === "VIEW" ? "view" : "table",
    }));
  }

  async listColumns(schema: string): Promise<ColumnMeta[]> {
    const pkRows = await this.run(
      `SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema ` +
        `WHERE tc.table_schema = '${lit(schema)}' AND tc.constraint_type = 'PRIMARY KEY'`
    );
    const pk = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`));
    const rows = await this.run(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position ` +
        `FROM information_schema.columns WHERE table_schema = '${lit(schema)}' ` +
        `ORDER BY table_name, ordinal_position`
    );
    return rows.map((r) => ({
      schema,
      relation: r.table_name,
      name: r.column_name,
      dataType: r.data_type,
      nullable: String(r.is_nullable).toUpperCase() === "YES",
      default: r.column_default ?? null,
      ordinal: Number(r.ordinal_position),
      isPrimaryKey: pk.has(`${r.table_name}.${r.column_name}`),
    }));
  }

  async listForeignKeys(schema: string): Promise<FkMeta[]> {
    const rows = await this.run(
      `SELECT tc.constraint_name, tc.table_schema AS src_schema, tc.table_name AS src_table, ` +
        `kcu.column_name AS src_column, ccu.table_schema AS dst_schema, ` +
        `ccu.table_name AS dst_table, ccu.column_name AS dst_column ` +
        `FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema ` +
        `JOIN information_schema.constraint_column_usage ccu ` +
        `ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema ` +
        `WHERE tc.table_schema = '${lit(schema)}' AND tc.constraint_type = 'FOREIGN KEY'`
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
  }

  async listRoutines(schema: string): Promise<RoutineMeta[]> {
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
  }

  async listViewDependencies(schema: string): Promise<ViewDepMeta[]> {
    const rows = await this.run(
      `SELECT view_schema, view_name, table_schema, table_name ` +
        `FROM information_schema.view_table_usage WHERE view_schema = '${lit(schema)}'`
    );
    return rows.map((r) => ({
      viewSchema: r.view_schema,
      viewName: r.view_name,
      tableSchema: r.table_schema,
      tableName: r.table_name,
    }));
  }
}
