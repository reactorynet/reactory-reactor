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

/** SQL Server structure reader over information_schema + sys (SELECT-only). */
export class MsSqlIntrospectionAdapter implements IIntrospectionAdapter {
  constructor(private run: SqlRunner) {}

  async listSchemas(): Promise<string[]> {
    const rows = await this.run(
      `SELECT name FROM sys.schemas ` +
        `WHERE name NOT IN ('sys', 'guest', 'INFORMATION_SCHEMA') AND schema_id < 16384 ORDER BY name`
    );
    return rows.map((r) => r.name);
  }

  async listRelations(schema: string): Promise<RelationMeta[]> {
    const rows = await this.run(
      `SELECT table_name, table_type FROM information_schema.tables ` +
        `WHERE table_schema = '${lit(schema)}' ORDER BY table_name`
    );
    return rows.map((r) => ({
      schema,
      name: r.table_name ?? r.TABLE_NAME,
      kind: String(r.table_type ?? r.TABLE_TYPE).toUpperCase() === "VIEW" ? "view" : "table",
    }));
  }

  async listColumns(schema: string): Promise<ColumnMeta[]> {
    const pkRows = await this.run(
      `SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema ` +
        `WHERE tc.table_schema = '${lit(schema)}' AND tc.constraint_type = 'PRIMARY KEY'`
    );
    const pk = new Set(
      pkRows.map((r) => `${r.table_name ?? r.TABLE_NAME}.${r.column_name ?? r.COLUMN_NAME}`)
    );
    const rows = await this.run(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position ` +
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
      isPrimaryKey: pk.has(`${r.table_name ?? r.TABLE_NAME}.${r.column_name ?? r.COLUMN_NAME}`),
    }));
  }

  async listForeignKeys(schema: string): Promise<FkMeta[]> {
    const rows = await this.run(
      `SELECT fk.name AS constraint_name, ` +
        `SCHEMA_NAME(tp.schema_id) AS src_schema, tp.name AS src_table, cp.name AS src_column, ` +
        `SCHEMA_NAME(tr.schema_id) AS dst_schema, tr.name AS dst_table, cr.name AS dst_column ` +
        `FROM sys.foreign_keys fk ` +
        `JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id ` +
        `JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id ` +
        `JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id ` +
        `JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id ` +
        `JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id ` +
        `WHERE SCHEMA_NAME(tp.schema_id) = '${lit(schema)}'`
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
      name: r.routine_name ?? r.ROUTINE_NAME,
      kind: String(r.routine_type ?? r.ROUTINE_TYPE ?? "procedure").toLowerCase(),
      returns: r.data_type ?? r.DATA_TYPE,
    }));
  }

  async listViewDependencies(schema: string): Promise<ViewDepMeta[]> {
    const rows = await this.run(
      `SELECT view_schema, view_name, table_schema, table_name ` +
        `FROM information_schema.view_table_usage WHERE view_schema = '${lit(schema)}'`
    );
    return rows.map((r) => ({
      viewSchema: r.view_schema ?? r.VIEW_SCHEMA,
      viewName: r.view_name ?? r.VIEW_NAME,
      tableSchema: r.table_schema ?? r.TABLE_SCHEMA,
      tableName: r.table_name ?? r.TABLE_NAME,
    }));
  }
}
