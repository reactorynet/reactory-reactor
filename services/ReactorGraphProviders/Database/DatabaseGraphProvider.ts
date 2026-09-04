import { service } from "@reactory/server-core/application/decorators";
import Hash from "@reactory/server-core/utils/hash";
import { ReactoryDatabaseVariant } from "@reactory/server-core/database/types";
import {
  IReactorProject,
  KnownReactorProjectTypes,
  ProcessOptions,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
  ReactorLinkType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import {
  linkId,
  nodeId,
  projectLogicalKey,
  sourceLogicalKey,
} from "../../graph/GraphIdentity";
import BaseExternalGraphProvider, {
  ExternalEntityBatch,
} from "../BaseExternalGraphProvider";
import {
  ColumnMeta,
  IIntrospectionAdapter,
  RelationMeta,
} from "./introspection/types";
import { makeIntrospectionAdapter, makeSqlRunner } from "./introspection/runner";

const SCHEME = "db";
const DEFAULT_MAX_TABLES = 2000;

export interface DatabaseSourceOptions {
  /** Core database variant of the connection (postgres | mysql | mssql | databricks). */
  variant: ReactoryDatabaseVariant;
  /** Schema allow-list. Default: every non-system schema (the default is logged — P4). */
  schemas?: string[];
  /** Include views (default true). */
  includeViews?: boolean;
  /** Include stored procedures / functions (default true). */
  includeRoutines?: boolean;
  /** Hard bound per schema; truncation is logged (invariant P4). Default 2000. */
  maxTablesPerSchema?: number;
}

/** Maps connection variants onto KnownDataSystems project types. */
const VARIANT_PROJECT_TYPE: Record<string, KnownReactorProjectTypes> = {
  postgres: "postgresql" as KnownReactorProjectTypes,
  mysql: "mysql" as KnownReactorProjectTypes,
  mssql: "tsql" as KnownReactorProjectTypes,
  databricks: "spark" as KnownReactorProjectTypes,
};

/**
 * DatabaseGraphProvider — snapshots a **live database's structure** (never row
 * data) into the system graph (Providers Session 05).
 *
 * Tree: root (DATASTORE) → connection info (CONNECTION, TSql precedent) and
 *       SCHEMAs → TABLEs / VIEWs / PROCEDUREs → COLUMNs.
 * Edges: FOREIGN_KEY column→referenced column and table→referenced table;
 *        view →DEPENDENCY→ table where the variant's catalog exposes usage.
 *
 * Identity (invariant P1):
 *   schema   db:<connectionId>/<schema>
 *   relation db:<connectionId>/<schema>/<relation>
 *   column   db:<connectionId>/<schema>/<relation>#<column>
 *   routine  db:<connectionId>/<schema>/routines#<name>
 *
 * Security (invariant P2): the project stores only the `connectionId`;
 * credentials resolve at runtime from partner connection settings through the
 * core connection factories. Nodes carry no host, port, username or password.
 * Every introspection statement is SELECT/SHOW-only — pair with a read-only
 * database account. Row data is never read (out of scope by design).
 *
 * Incremental: a relation's contentHash is the hash of its ordered column
 * tuples; each column hashes its own tuple — unchanged structure skips
 * re-persist and re-index. FK targets in non-allow-listed schemas become stub
 * TABLE nodes (invariant P6) so no edge dangles.
 *
 * Complements `TSqlProjectProcessor`, which graphs SQL *project files* on
 * disk; this provider graphs the live catalog.
 */
@service({
  name: "DatabaseGraphProvider",
  nameSpace: "reactor",
  version: "1.0.0",
  description:
    "Graphs a live database's structure (schemas, tables, views, columns, foreign keys, routines) into the system graph. Structure only — never row data.",
  id: "reactor.DatabaseGraphProvider@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
export class DatabaseGraphProvider extends BaseExternalGraphProvider {
  nameSpace = "reactor";
  name = "DatabaseGraphProvider";
  version = "1.0.0";

  sourceScheme(): string {
    return SCHEME;
  }

  protected rootNodeType(): ReactorNodeType {
    return ReactorNodeType.DATASTORE;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    if (!this.supportsProject(project)) return [];
    const variant = this.optionsOf(project).variant;
    const mapped = VARIANT_PROJECT_TYPE[variant];
    return mapped ? [mapped] : [];
  }

  private optionsOf(project: Partial<IReactorProject>): DatabaseSourceOptions {
    return (project?.source?.options || {}) as DatabaseSourceOptions;
  }

  /**
   * Adapter construction seam — tests override this with a fake adapter so no
   * live database is ever touched by the suite.
   */
  protected async adapterFor(
    project: Partial<IReactorProject>
  ): Promise<IIntrospectionAdapter> {
    const opts = this.optionsOf(project);
    const connectionId = this.sourceKeyFor(project);
    const run = await makeSqlRunner(opts.variant, connectionId, this.context);
    return makeIntrospectionAdapter(opts.variant, run);
  }

  // ---- node builders ---------------------------------------------------------

  private baseNode(
    project: Partial<IReactorProject>,
    id: number,
    name: string,
    type: ReactorNodeType,
    parentId: number,
    parentKey: string,
    data: Record<string, any>
  ): Partial<ReactorNode> {
    return {
      id,
      index: id,
      name,
      key: `${parentKey}|${id}`,
      type,
      parentId,
      providerId: this.fqn(),
      nameSpace: project.nameSpace,
      version: project.version,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data,
    };
  }

  private relationHash(columns: ColumnMeta[]): string {
    return String(
      Hash(
        JSON.stringify(
          columns.map((c) => [c.name, c.dataType, c.nullable, c.default ?? null, !!c.isPrimaryKey])
        )
      )
    );
  }

  private columnHash(c: ColumnMeta): string {
    return String(
      Hash(JSON.stringify([c.name, c.dataType, c.nullable, c.default ?? null, !!c.isPrimaryKey, c.ordinal]))
    );
  }

  // ---- discovery -----------------------------------------------------------------

  async *discoverEntities(
    project: Partial<IReactorProject>,
    _options: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch> {
    const opts = this.optionsOf(project);
    const connectionId = this.sourceKeyFor(project);
    if (!connectionId) {
      throw new Error("db source requires source.sourceKey (the connectionId)");
    }
    if (!opts.variant) {
      throw new Error("db source requires source.options.variant (postgres | mysql | mssql | databricks)");
    }

    const adapter = await this.adapterFor(project);
    const rootId = nodeId(projectLogicalKey(project));
    const maxTables = opts.maxTablesPerSchema ?? DEFAULT_MAX_TABLES;

    // Connection info node (TSql Connections precedent). connectionId only — no host/credentials (P2).
    const connNodeId = nodeId(sourceLogicalKey(SCHEME, connectionId, undefined, "connection"));
    yield {
      nodes: [
        this.baseNode(project, connNodeId, "Connection", ReactorNodeType.CONNECTION, rootId, `${rootId}`, {
          kind: "connection",
          connectionId,
          variant: opts.variant,
          noExpand: true,
        }),
      ],
    };

    // Schema scope (allow-list or all non-system, logged either way — P4).
    const allSchemas = await adapter.listSchemas();
    let schemas = allSchemas;
    if (opts.schemas && opts.schemas.length > 0) {
      const allow = new Set(opts.schemas.map((s) => s.toLowerCase()));
      schemas = allSchemas.filter((s) => allow.has(s.toLowerCase()));
      const missing = opts.schemas.filter(
        (s) => !allSchemas.some((a) => a.toLowerCase() === s.toLowerCase())
      );
      if (missing.length) {
        this.context.warn(
          `db snapshot ${connectionId}: allow-listed schemas not found: ${missing.join(", ")}`
        );
      }
    } else {
      this.context.info(
        `db snapshot ${connectionId}: no schema allow-list configured — snapshotting all ${allSchemas.length} non-system schemas`
      );
    }
    const inScope = new Set(schemas.map((s) => s.toLowerCase()));
    /** Stub relation ids emitted (FK targets outside the allow-list). */
    const stubIds = new Set<number>();
    /** Full relation ids emitted so far (a late stub must never overwrite one). */
    const fullRelationIds = new Set<number>();

    for (const schema of schemas) {
      const schemaId = nodeId(sourceLogicalKey(SCHEME, connectionId, schema));
      const schemaKey = `${rootId}|${schemaId}`;
      const nodes: Partial<ReactorNode>[] = [
        this.baseNode(project, schemaId, schema, ReactorNodeType.SCHEMA, rootId, `${rootId}`, {
          kind: "schema",
          schema,
          connectionId,
        }),
      ];
      const edges: ReactorNodeLink[] = [];
      const searchables: any[] = [];

      let relations = await adapter.listRelations(schema);
      if (!(opts.includeViews ?? true)) {
        relations = relations.filter((r) => r.kind !== "view");
      }
      if (relations.length > maxTables) {
        this.context.warn(
          `db snapshot truncated for ${connectionId}/${schema}: ${relations.length} relations, keeping first ${maxTables} (maxTablesPerSchema)`
        );
        relations = relations.slice(0, maxTables);
      }
      const keptRelations = new Set(relations.map((r) => r.name));

      const columns = await adapter.listColumns(schema);
      const columnsByRelation = new Map<string, ColumnMeta[]>();
      for (const c of columns) {
        if (!keptRelations.has(c.relation)) continue;
        const list = columnsByRelation.get(c.relation) || [];
        list.push(c);
        columnsByRelation.set(c.relation, list);
      }

      for (const rel of relations) {
        const relId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${schema}/${rel.name}`));
        fullRelationIds.add(relId);
        const relColumns = (columnsByRelation.get(rel.name) || []).sort((a, b) => a.ordinal - b.ordinal);
        const pkColumns = relColumns.filter((c) => c.isPrimaryKey).map((c) => c.name);
        const relNode = this.baseNode(
          project,
          relId,
          rel.name,
          rel.kind === "view" ? ReactorNodeType.VIEW : ReactorNodeType.TABLE,
          schemaId,
          schemaKey,
          {
            kind: rel.kind,
            searchId: sourceLogicalKey(SCHEME, connectionId, `${schema}/${rel.name}`),
            schema,
            relation: rel.name,
            connectionId,
            comment: rel.comment,
            columnCount: relColumns.length,
            pkColumns,
          }
        );
        relNode.description = rel.comment || `${rel.kind} ${schema}.${rel.name}`;
        relNode.contentHash = this.relationHash(relColumns);
        nodes.push(relNode);

        for (const col of relColumns) {
          const colId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${schema}/${rel.name}`, col.name));
          const colNode = this.baseNode(
            project,
            colId,
            col.name,
            ReactorNodeType.COLUMN,
            relId,
            `${schemaKey}|${relId}`,
            {
              kind: "column",
              schema,
              relation: rel.name,
              column: col.name,
              dataType: col.dataType,
              nullable: col.nullable,
              default: col.default ?? undefined,
              ordinal: col.ordinal,
              isPk: !!col.isPrimaryKey,
              comment: col.comment,
              noExpand: true,
            }
          );
          colNode.description = `${col.dataType}${col.nullable ? "" : " NOT NULL"}${col.isPrimaryKey ? " PK" : ""}`;
          colNode.contentHash = this.columnHash(col);
          nodes.push(colNode);
        }

        const searchText = [
          `${schema}.${rel.name}`,
          rel.comment || "",
          relColumns.map((c) => `${c.name} ${c.dataType}${c.comment ? ` ${c.comment}` : ""}`).join("\n"),
        ]
          .filter(Boolean)
          .join("\n");
        searchables.push({
          id: sourceLogicalKey(SCHEME, connectionId, `${schema}/${rel.name}`),
          nodeId: relId,
          name: `${schema}.${rel.name}`,
          nameSpace: project.nameSpace,
          version: project.version,
          source: searchText.slice(0, 100_000),
          path: `${schema}/${rel.name}`,
          relativePath: `${schema}/${rel.name}`,
          type: { id: rel.kind, name: rel.kind },
        });
      }

      // Foreign keys — column→column and table→table (deduped by deterministic id).
      const fks = await adapter.listForeignKeys(schema);
      for (const fk of fks) {
        if (!keptRelations.has(fk.srcTable)) continue;
        const srcTableId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${fk.srcSchema}/${fk.srcTable}`));
        const dstTableId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${fk.dstSchema}/${fk.dstTable}`));
        const srcColId = nodeId(
          sourceLogicalKey(SCHEME, connectionId, `${fk.srcSchema}/${fk.srcTable}`, fk.srcColumn)
        );
        const dstColId = nodeId(
          sourceLogicalKey(SCHEME, connectionId, `${fk.dstSchema}/${fk.dstTable}`, fk.dstColumn)
        );

        // FK target outside the allow-list → stub TABLE (P6), never over a full node.
        if (!inScope.has(fk.dstSchema.toLowerCase()) && !fullRelationIds.has(dstTableId) && !stubIds.has(dstTableId)) {
          stubIds.add(dstTableId);
          nodes.push(
            this.baseNode(project, dstTableId, fk.dstTable, ReactorNodeType.TABLE, rootId, `${rootId}`, {
              kind: "table",
              stub: true,
              schema: fk.dstSchema,
              relation: fk.dstTable,
              connectionId,
              noExpand: true,
            })
          );
        }

        edges.push({
          id: linkId(srcTableId, dstTableId, ReactorLinkType.FOREIGN_KEY),
          source: srcTableId,
          target: dstTableId,
          types: [ReactorLinkType.FOREIGN_KEY],
          title: fk.constraintName,
          data: { constraintName: fk.constraintName },
        } as ReactorNodeLink);

        // Column-level edge only when both column nodes exist this run (I4):
        // the referenced column of an out-of-scope table is not materialised.
        if (inScope.has(fk.dstSchema.toLowerCase()) || fullRelationIds.has(dstTableId)) {
          edges.push({
            id: linkId(srcColId, dstColId, ReactorLinkType.FOREIGN_KEY),
            source: srcColId,
            target: dstColId,
            types: [ReactorLinkType.FOREIGN_KEY],
            title: `${fk.constraintName} (${fk.srcColumn} → ${fk.dstColumn})`,
            data: { constraintName: fk.constraintName },
          } as ReactorNodeLink);
        }
      }

      // View dependencies where the catalog exposes them.
      if ((opts.includeViews ?? true) && typeof adapter.listViewDependencies === "function") {
        try {
          const deps = await adapter.listViewDependencies(schema);
          for (const dep of deps) {
            if (!keptRelations.has(dep.viewName)) continue;
            if (!inScope.has(dep.tableSchema.toLowerCase())) continue;
            const viewId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${dep.viewSchema}/${dep.viewName}`));
            const tableId = nodeId(sourceLogicalKey(SCHEME, connectionId, `${dep.tableSchema}/${dep.tableName}`));
            if (viewId === tableId) continue;
            edges.push({
              id: linkId(viewId, tableId, ReactorLinkType.DEPENDENCY),
              source: viewId,
              target: tableId,
              types: [ReactorLinkType.DEPENDENCY],
              title: `view dependency`,
            } as ReactorNodeLink);
          }
        } catch (err) {
          this.context.warn(
            `db view-dependency introspection failed for ${connectionId}/${schema}: ${(err as Error).message}`
          );
        }
      }

      // Routines.
      if (opts.includeRoutines ?? true) {
        try {
          const routines = await adapter.listRoutines(schema);
          for (const routine of routines) {
            const routineId = nodeId(
              sourceLogicalKey(SCHEME, connectionId, `${schema}/routines`, routine.name)
            );
            const routineNode = this.baseNode(
              project,
              routineId,
              routine.name,
              ReactorNodeType.PROCEDURE,
              schemaId,
              schemaKey,
              {
                kind: "routine",
                searchId: sourceLogicalKey(SCHEME, connectionId, `${schema}/routines`, routine.name),
                schema,
                routine: routine.name,
                routineKind: routine.kind,
                returns: routine.returns,
                connectionId,
                noExpand: true,
              }
            );
            routineNode.description = `${routine.kind} ${schema}.${routine.name}`;
            nodes.push(routineNode);
            searchables.push({
              id: sourceLogicalKey(SCHEME, connectionId, `${schema}/routines`, routine.name),
              nodeId: routineId,
              name: `${schema}.${routine.name}`,
              nameSpace: project.nameSpace,
              version: project.version,
              source: `${routine.kind} ${schema}.${routine.name}${routine.returns ? ` returns ${routine.returns}` : ""}`,
              path: `${schema}/routines/${routine.name}`,
              relativePath: `${schema}/routines/${routine.name}`,
              type: { id: "routine", name: "routine" },
            });
          }
        } catch (err) {
          this.context.warn(
            `db routine introspection failed for ${connectionId}/${schema}: ${(err as Error).message}`
          );
        }
      }

      yield { nodes, edges, searchables };
    }
  }
}

export default DatabaseGraphProvider;
