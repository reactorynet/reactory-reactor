import {
  ColumnMeta,
  FkMeta,
  IIntrospectionAdapter,
  RelationMeta,
  RoutineMeta,
  SqlRunner,
  lit,
} from "./types";

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

/** MySQL structure reader over information_schema (SELECT-only). */
export class MySqlIntrospectionAdapter implements IIntrospectionAdapter {
  constructor(private run: SqlRunner) {}

  async listSchemas(): Promise<string[]> {
    const rows = await this.run(
      `SELECT schema_name FROM information_schema.schemata ` +
        `WHERE schema_name NOT IN (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ")}) ORDER BY schema_name`
    );
    return rows.map((r) => r.schema_name ?? r.SCHEMA_NAME);
  }

  async listRelations(schema: string): Promise<RelationMeta[]> {
    const rows = await this.run(
      `SELECT table_name, table_type, table_comment FROM information_schema.tables ` +
        `WHERE table_schema = '${lit(schema)}' ORDER BY table_name`
    );
    return rows.map((r) => ({
      schema,
      name: r.table_name ?? r.TABLE_NAME,
      kind: String(r.table_type ?? r.TABLE_TYPE).toUpperCase() === "VIEW" ? "view" : "table",
      comment: (r.table_comment ?? r.TABLE_COMMENT) || undefined,
    }));
  }

  async listColumns(schema: string): Promise<ColumnMeta[]> {
    const rows = await this.run(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, ` +
        `ordinal_position, column_comment, column_key ` +
        `FROM information_schema.columns WHERE table_schema = '${lit(schema)}' ` +
        `ORDER BY table_name, ordinal_position`
    );
    return rows.map((r) => ({
      schema,
      relation: r.table_name ?? r.TABLE_NAME,
      name: r.column_name ?? r.COLUMN_NAME,
      dataType: r.data_type ?? r.DATA_TYPE,
      nullable: String(r.is_nullable ?? r.IS_NULLABLE).toUpperCase() === "YES",
      default: (r.column_default ?? r.COLUMN_DEFAULT) ?? null,
      ordinal: Number(r.ordinal_position ?? r.ORDINAL_POSITION),
      comment: (r.column_comment ?? r.COLUMN_COMMENT) || undefined,
      isPrimaryKey: String(r.column_key ?? r.COLUMN_KEY).toUpperCase() === "PRI",
    }));
  }

  async listForeignKeys(schema: string): Promise<FkMeta[]> {
    const rows = await this.run(
      `SELECT constraint_name, table_schema, table_name, column_name, ` +
        `referenced_table_schema, referenced_table_name, referenced_column_name ` +
        `FROM information_schema.key_column_usage ` +
        `WHERE table_schema = '${lit(schema)}' AND referenced_table_name IS NOT NULL`
    );
    return rows.map((r) => ({
      constraintName: r.constraint_name ?? r.CONSTRAINT_NAME,
      srcSchema: r.table_schema ?? r.TABLE_SCHEMA,
      srcTable: r.table_name ?? r.TABLE_NAME,
      srcColumn: r.column_name ?? r.COLUMN_NAME,
      dstSchema: r.referenced_table_schema ?? r.REFERENCED_TABLE_SCHEMA,
      dstTable: r.referenced_table_name ?? r.REFERENCED_TABLE_NAME,
      dstColumn: r.referenced_column_name ?? r.REFERENCED_COLUMN_NAME,
    }));
  }

  async listRoutines(schema: string): Promise<RoutineMeta[]> {
    const rows = await this.run(
      `SELECT routine_name, routine_type, data_type FROM information_schema.routines ` +
        `WHERE routine_schema = '${lit(schema)}' ORDER BY routine_name`
    );
    return rows.map((r) => ({
      schema,
      name: r.routine_name ?? r.ROUTINE_NAME,
      kind: String(r.routine_type ?? r.ROUTINE_TYPE ?? "function").toLowerCase(),
      returns: r.data_type ?? r.DATA_TYPE,
    }));
  }
}
