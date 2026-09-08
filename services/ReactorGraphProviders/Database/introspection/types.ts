/**
 * Introspection contract for the DatabaseGraphProvider (Providers Session 05).
 *
 * Adapters are constructed over a `SqlRunner` — a function executing one
 * **SELECT/SHOW** statement and returning rows — so provider logic and tests
 * are independent of the driver. Every statement an adapter issues MUST be
 * read-only (asserted by tests); recommend a read-only database account in
 * client configs.
 */

/** Executes one read-only SQL statement, returning plain row objects. */
export type SqlRunner = (sql: string) => Promise<any[]>;

export interface RelationMeta {
  schema: string;
  name: string;
  /** 'table' | 'view' */
  kind: "table" | "view";
  comment?: string;
}

export interface ColumnMeta {
  schema: string;
  relation: string;
  name: string;
  dataType: string;
  nullable: boolean;
  default?: string | null;
  ordinal: number;
  comment?: string;
  isPrimaryKey?: boolean;
}

export interface FkMeta {
  constraintName: string;
  srcSchema: string;
  srcTable: string;
  srcColumn: string;
  dstSchema: string;
  dstTable: string;
  dstColumn: string;
}

export interface RoutineMeta {
  schema: string;
  name: string;
  /** 'procedure' | 'function' */
  kind: string;
  returns?: string;
  comment?: string;
}

export interface ViewDepMeta {
  viewSchema: string;
  viewName: string;
  tableSchema: string;
  tableName: string;
}

/**
 * One database variant's structure reader. `listColumns`/`listPrimaryKeys`
 * are **per schema** (one statement per schema, not per relation) so a
 * 2000-table schema costs a handful of queries, not thousands.
 */
export interface IIntrospectionAdapter {
  listSchemas(): Promise<string[]>;
  listRelations(schema: string): Promise<RelationMeta[]>;
  listColumns(schema: string): Promise<ColumnMeta[]>;
  listForeignKeys(schema: string): Promise<FkMeta[]>;
  listRoutines(schema: string): Promise<RoutineMeta[]>;
  /** Optional — only variants whose catalog exposes view→table usage. */
  listViewDependencies?(schema: string): Promise<ViewDepMeta[]>;
}

/** Escapes a string literal for embedding in an introspection query. */
export const lit = (value: string): string => String(value).replace(/'/g, "''");
