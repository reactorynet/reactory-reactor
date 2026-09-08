import { makeContext } from "../../graph/testUtils";
import {
  nodeId,
  projectLogicalKey,
  sourceLogicalKey,
} from "../../graph/GraphIdentity";
import {
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
  ReactorLinkType,
} from "../../../types/model.types";
import { IReactorProject } from "../../../types/service.types";
import DatabaseGraphProvider from "./DatabaseGraphProvider";
import {
  ColumnMeta,
  FkMeta,
  IIntrospectionAdapter,
  RelationMeta,
  RoutineMeta,
  SqlRunner,
  ViewDepMeta,
} from "./introspection/types";
import { PostgresIntrospectionAdapter } from "./introspection/postgres";
import { MySqlIntrospectionAdapter } from "./introspection/mysql";
import { MsSqlIntrospectionAdapter } from "./introspection/mssql";
import { DatabricksIntrospectionAdapter } from "./introspection/databricks";

const CONN = "sales-dwh";

// ---------------------------------------------------------------------------
// Fake introspection adapter — 2 schemas, FKs (composite + cross-schema),
// a view + dependency, a routine. No live database anywhere near this suite.
// ---------------------------------------------------------------------------

class FakeAdapter implements IIntrospectionAdapter {
  schemas = ["public", "billing"];
  relations: Record<string, RelationMeta[]> = {
    public: [
      { schema: "public", name: "users", kind: "table", comment: "All users" },
      { schema: "public", name: "orders", kind: "table" },
      { schema: "public", name: "order_totals", kind: "view" },
    ],
    billing: [{ schema: "billing", name: "invoices", kind: "table" }],
  };
  columns: Record<string, ColumnMeta[]> = {
    public: [
      { schema: "public", relation: "users", name: "id", dataType: "integer", nullable: false, ordinal: 1, isPrimaryKey: true },
      { schema: "public", relation: "users", name: "email", dataType: "text", nullable: false, ordinal: 2, comment: "login email" },
      { schema: "public", relation: "orders", name: "id", dataType: "integer", nullable: false, ordinal: 1, isPrimaryKey: true },
      { schema: "public", relation: "orders", name: "user_id", dataType: "integer", nullable: false, ordinal: 2 },
      { schema: "public", relation: "orders", name: "customer_ref", dataType: "integer", nullable: true, ordinal: 3 },
      { schema: "public", relation: "order_totals", name: "order_id", dataType: "integer", nullable: true, ordinal: 1 },
    ],
    billing: [
      { schema: "billing", relation: "invoices", name: "id", dataType: "integer", nullable: false, ordinal: 1, isPrimaryKey: true },
      { schema: "billing", relation: "invoices", name: "order_id", dataType: "integer", nullable: false, ordinal: 2 },
    ],
  };
  fks: Record<string, FkMeta[]> = {
    public: [
      {
        constraintName: "orders_user_id_fkey",
        srcSchema: "public", srcTable: "orders", srcColumn: "user_id",
        dstSchema: "public", dstTable: "users", dstColumn: "id",
      },
      {
        constraintName: "orders_customer_ref_fkey",
        srcSchema: "public", srcTable: "orders", srcColumn: "customer_ref",
        dstSchema: "crm", dstTable: "customers", dstColumn: "id", // cross-schema, non-listed
      },
    ],
    billing: [
      {
        constraintName: "invoices_order_id_fkey",
        srcSchema: "billing", srcTable: "invoices", srcColumn: "order_id",
        dstSchema: "public", dstTable: "orders", dstColumn: "id", // cross-schema, in scope
      },
    ],
  };
  routines: Record<string, RoutineMeta[]> = {
    public: [{ schema: "public", name: "calc_total", kind: "function", returns: "numeric" }],
    billing: [],
  };
  viewDeps: Record<string, ViewDepMeta[]> = {
    public: [
      { viewSchema: "public", viewName: "order_totals", tableSchema: "public", tableName: "orders" },
    ],
    billing: [],
  };

  async listSchemas() { return this.schemas; }
  async listRelations(schema: string) { return this.relations[schema] || []; }
  async listColumns(schema: string) { return this.columns[schema] || []; }
  async listForeignKeys(schema: string) { return this.fks[schema] || []; }
  async listRoutines(schema: string) { return this.routines[schema] || []; }
  async listViewDependencies(schema: string) { return this.viewDeps[schema] || []; }
}

class TestableDbProvider extends DatabaseGraphProvider {
  adapter = new FakeAdapter();
  nodesStore = new Map<number, any>();
  edgesStore = new Map<number, any>();
  indexedSearchables: any[] = [];
  touchedNodeIds: number[] = [];
  gcCalls = 0;

  protected async adapterFor(): Promise<IIntrospectionAdapter> {
    return this.adapter;
  }

  protected async persistGraph(nodes: Partial<ReactorNode>[], edges: ReactorNodeLink[], meta?: any) {
    const store = (map: Map<number, any>, entity: any) => {
      if (!entity || entity.id === undefined || entity.id === null) return;
      map.set(entity.id, {
        ...entity,
        projectId: meta?.projectId !== undefined ? String(meta.projectId) : entity.projectId,
        runId: meta?.runId,
      });
    };
    nodes.forEach((n) => store(this.nodesStore, n));
    edges.forEach((e) => store(this.edgesStore, e));
    return { ok: true, nodeOps: nodes.length, edgeOps: edges.length };
  }

  protected async gcStale(projectId: string, runId: string) {
    this.gcCalls++;
    let nodesGcDeleted = 0;
    let edgesGcDeleted = 0;
    for (const [id, node] of Array.from(this.nodesStore.entries())) {
      if (String(node.projectId) === String(projectId) && node.runId !== runId && node.runId !== "manual") {
        this.nodesStore.delete(id); nodesGcDeleted++;
      }
    }
    for (const [id, edge] of Array.from(this.edgesStore.entries())) {
      if (String(edge.projectId) === String(projectId) && edge.runId !== runId && edge.runId !== "manual") {
        this.edgesStore.delete(id); edgesGcDeleted++;
      }
    }
    return { nodesGcDeleted, edgesGcDeleted };
  }

  protected async loadPreviousNodes(project: Partial<IReactorProject>) {
    const m = new Map<number, Partial<ReactorNode>>();
    for (const [id, node] of this.nodesStore.entries()) {
      if (String(node.projectId) === String(project.id)) m.set(id, node);
    }
    return m;
  }

  protected async loadDescendantNodeIds(parentId: number, projectId: string) {
    const ids: number[] = [];
    for (const [id, node] of this.nodesStore.entries()) {
      if (String(node.projectId) === String(projectId) && node.parentId === parentId) ids.push(id);
    }
    return ids;
  }

  protected async loadEdgeIdsTouching(nodeIds: number[], projectId: string) {
    const ids: number[] = [];
    for (const [id, edge] of this.edgesStore.entries()) {
      if (
        String(edge.projectId) === String(projectId) &&
        (nodeIds.includes(edge.source) || nodeIds.includes(edge.target))
      ) ids.push(id);
    }
    return ids;
  }

  protected async touchNodes(ids: number[], meta: { runId: string; indexedAt: Date }) {
    this.touchedNodeIds.push(...ids);
    ids.forEach((id) => {
      const n = this.nodesStore.get(id);
      if (n) n.runId = meta.runId;
    });
  }

  protected async touchEdges(ids: number[], meta: { runId: string; indexedAt: Date }) {
    ids.forEach((id) => {
      const e = this.edgesStore.get(id);
      if (e) e.runId = meta.runId;
    });
  }

  protected async indexSearchables(_p: Partial<IReactorProject>, searchables: any[]) {
    this.indexedSearchables.push(...searchables);
  }
}

const makeProject = (options: any = {}): Partial<IReactorProject> =>
  ({
    id: "db-proj-1",
    name: "sales-dwh",
    nameSpace: "db",
    version: "1.0.0",
    source: { scheme: "db", sourceKey: CONN, options: { variant: "postgres", ...options } },
    processors: [{ id: "db", processor: "reactor.DatabaseGraphProvider@1.0.0" }],
    projectTypes: ["postgresql"] as any,
  } as Partial<IReactorProject>);

const setup = (options: any = {}) => {
  const context = makeContext();
  context.warn = jest.fn();
  context.info = jest.fn();
  context.error = jest.fn();
  const provider = new TestableDbProvider({} as any, context);
  return { provider, project: makeProject(options), context };
};

const sid = (schema: string) => nodeId(sourceLogicalKey("db", CONN, schema));
const rid = (schema: string, rel: string) => nodeId(sourceLogicalKey("db", CONN, `${schema}/${rel}`));
const colid = (schema: string, rel: string, col: string) =>
  nodeId(sourceLogicalKey("db", CONN, `${schema}/${rel}`, col));
const routid = (schema: string, name: string) =>
  nodeId(sourceLogicalKey("db", CONN, `${schema}/routines`, name));

describe("DatabaseGraphProvider — structure snapshot", () => {
  it("supportsProject only for db source scheme", () => {
    const { provider } = setup();
    expect(provider.supportsProject(makeProject())).toBe(true);
    expect(provider.supportsProject({ source: { scheme: "jira", sourceKey: "x" } } as any)).toBe(false);
    expect(provider.supportsProject({ repoPath: "/tmp" } as any)).toBe(false);
  });

  it("builds DATASTORE → connection/schemas → relations → columns with deterministic ids", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const rootId = nodeId(projectLogicalKey(project));

    const conn = provider.nodesStore.get(nodeId(sourceLogicalKey("db", CONN, undefined, "connection")));
    expect(conn?.type).toBe(ReactorNodeType.CONNECTION);
    expect(conn?.parentId).toBe(rootId);

    expect(provider.nodesStore.get(sid("public"))?.type).toBe(ReactorNodeType.SCHEMA);
    const users = provider.nodesStore.get(rid("public", "users"));
    expect(users?.type).toBe(ReactorNodeType.TABLE);
    expect(users?.parentId).toBe(sid("public"));
    expect(users?.data?.pkColumns).toEqual(["id"]);
    expect(users?.data?.columnCount).toBe(2);
    expect(provider.nodesStore.get(rid("public", "order_totals"))?.type).toBe(ReactorNodeType.VIEW);

    const email = provider.nodesStore.get(colid("public", "users", "email"));
    expect(email?.type).toBe(ReactorNodeType.COLUMN);
    expect(email?.parentId).toBe(rid("public", "users"));
    expect(email?.data?.dataType).toBe("text");

    const routine = provider.nodesStore.get(routid("public", "calc_total"));
    expect(routine?.type).toBe(ReactorNodeType.PROCEDURE);
    expect(routine?.parentId).toBe(sid("public"));
  });

  it("emits FOREIGN_KEY edges at table and column level", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const edges = Array.from(provider.edgesStore.values());
    const fks = edges.filter((e) => e.types.includes(ReactorLinkType.FOREIGN_KEY));

    const tablePairs = fks.map((e) => [e.source, e.target]);
    expect(tablePairs).toContainEqual([rid("public", "orders"), rid("public", "users")]);
    expect(tablePairs).toContainEqual([
      colid("public", "orders", "user_id"),
      colid("public", "users", "id"),
    ]);
    // cross-schema in-scope FK (billing.invoices → public.orders)
    expect(tablePairs).toContainEqual([rid("billing", "invoices"), rid("public", "orders")]);
    expect(fks.find((e) => e.source === rid("public", "orders") && e.target === rid("public", "users"))?.title).toBe(
      "orders_user_id_fkey"
    );
  });

  it("stubs FK targets in non-allow-listed schemas (P6) and skips their column edges (I4)", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const crmCustomers = provider.nodesStore.get(rid("crm", "customers"));
    expect(crmCustomers?.data?.stub).toBe(true);
    expect(crmCustomers?.type).toBe(ReactorNodeType.TABLE);

    const edges = Array.from(provider.edgesStore.values());
    // table-level edge exists...
    expect(edges.some((e) => e.target === rid("crm", "customers"))).toBe(true);
    // ...but no column-level edge into the never-materialised crm column
    expect(edges.some((e) => e.target === colid("crm", "customers", "id"))).toBe(false);
  });

  it("emits view → table DEPENDENCY edges", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const deps = Array.from(provider.edgesStore.values()).filter((e) =>
      e.types.includes(ReactorLinkType.DEPENDENCY)
    );
    expect(deps.map((e) => [e.source, e.target])).toContainEqual([
      rid("public", "order_totals"),
      rid("public", "orders"),
    ]);
  });

  it("indexes relations and routines with graph-aligned nodeIds", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const byNodeId = new Map(provider.indexedSearchables.map((s) => [s.nodeId, s]));
    const users = byNodeId.get(rid("public", "users"));
    expect(users.name).toBe("public.users");
    expect(users.source).toContain("All users");
    expect(users.source).toContain("email text login email");
    expect(byNodeId.has(routid("public", "calc_total"))).toBe(true);
    // stubs are never indexed
    expect(byNodeId.has(rid("crm", "customers"))).toBe(false);
  });

  it("honours the schema allow-list and logs unknown entries", async () => {
    const { provider, project, context } = setup({ schemas: ["billing", "ghost"] });
    await provider.process(project);
    expect(provider.nodesStore.get(sid("billing"))).toBeTruthy();
    expect(provider.nodesStore.get(sid("public"))).toBeUndefined();
    expect(
      (context.warn as jest.Mock).mock.calls.some((c: any[]) => String(c[0]).includes("ghost"))
    ).toBe(true);
    // public.orders is now out of scope → the billing FK target becomes a stub
    expect(provider.nodesStore.get(rid("public", "orders"))?.data?.stub).toBe(true);
  });

  it("logs when no allow-list is configured (defaulting to all schemas — P4)", async () => {
    const { provider, project, context } = setup();
    await provider.process(project);
    expect(
      (context.info as jest.Mock).mock.calls.some((c: any[]) =>
        String(c[0]).includes("no schema allow-list")
      )
    ).toBe(true);
  });

  it("truncates at maxTablesPerSchema with a warning (P4)", async () => {
    const { provider, project, context } = setup({ maxTablesPerSchema: 1 });
    await provider.process(project);
    expect(
      (context.warn as jest.Mock).mock.calls.some((c: any[]) => String(c[0]).includes("truncated"))
    ).toBe(true);
    // only the first relation of public survives
    expect(provider.nodesStore.get(rid("public", "users"))?.data?.stub).toBeUndefined();
    expect(provider.nodesStore.get(rid("public", "order_totals"))).toBeUndefined();
  });

  it("includeViews / includeRoutines flags narrow the snapshot", async () => {
    const { provider, project } = setup({ includeViews: false, includeRoutines: false });
    await provider.process(project);
    expect(provider.nodesStore.get(rid("public", "order_totals"))).toBeUndefined();
    expect(provider.nodesStore.get(routid("public", "calc_total"))).toBeUndefined();
  });

  it("is idempotent and GCs dropped tables on the next run", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const first = new Set(provider.nodesStore.keys());
    await provider.process(project);
    expect(new Set(provider.nodesStore.keys())).toEqual(first);

    provider.adapter.relations.public = provider.adapter.relations.public.filter((r) => r.name !== "orders");
    provider.adapter.fks.public = [];
    provider.adapter.fks.billing = [];
    provider.adapter.viewDeps.public = [];
    await provider.process(project);
    expect(provider.nodesStore.get(rid("public", "orders"))).toBeUndefined();
    expect(provider.nodesStore.get(rid("public", "users"))).toBeTruthy();
  });

  it("skips unchanged relations by column-set hash; added column re-analyses", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    provider.indexedSearchables = [];
    provider.touchedNodeIds = [];

    provider.adapter.columns.public.push({
      schema: "public", relation: "users", name: "created_at", dataType: "timestamp", nullable: true, ordinal: 3,
    });
    await provider.process(project);

    const reindexed = provider.indexedSearchables.map((s) => s.nodeId);
    expect(reindexed).toContain(rid("public", "users"));
    expect(reindexed).not.toContain(rid("public", "orders"));
    expect(provider.touchedNodeIds).toContain(rid("public", "orders"));
    expect(provider.nodesStore.get(colid("public", "users", "created_at"))).toBeTruthy();
  });

  it("fails safe: missing variant → error recorded, no GC", async () => {
    const { provider, project } = setup();
    (project.source as any).options = {};
    await provider.process(project);
    expect(provider.gcCalls).toBe(0);
    expect(provider.lastMetrics?.errors).toBeGreaterThan(0);
  });

  it("persists no credentials, hosts or connection strings (P2)", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const everything = JSON.stringify([
      ...provider.nodesStore.values(),
      ...provider.edgesStore.values(),
      ...provider.indexedSearchables,
    ]);
    ["password", "username", "host", "port", "jdbc:", "postgres://"].forEach((secret) =>
      expect(everything).not.toContain(`"${secret}"`)
    );
    // the connection node carries only the connectionId
    const conn = provider.nodesStore.get(nodeId(sourceLogicalKey("db", CONN, undefined, "connection")));
    expect(Object.keys(conn.data).sort()).toEqual(["connectionId", "kind", "noExpand", "variant"]);
  });
});

// ---------------------------------------------------------------------------
// Variant SQL builders — every statement must be read-only (SELECT/SHOW)
// ---------------------------------------------------------------------------

describe("introspection adapters — read-only statement guarantee", () => {
  const capture = () => {
    const statements: string[] = [];
    const run: SqlRunner = async (sql) => {
      statements.push(sql);
      return [];
    };
    return { statements, run };
  };

  const drive = async (adapter: IIntrospectionAdapter) => {
    await adapter.listSchemas();
    await adapter.listRelations("public");
    await adapter.listColumns("public");
    await adapter.listForeignKeys("public");
    await adapter.listRoutines("public");
    if (adapter.listViewDependencies) await adapter.listViewDependencies("public");
  };

  it.each([
    ["postgres", (run: SqlRunner) => new PostgresIntrospectionAdapter(run)],
    ["mysql", (run: SqlRunner) => new MySqlIntrospectionAdapter(run)],
    ["mssql", (run: SqlRunner) => new MsSqlIntrospectionAdapter(run)],
    ["databricks", (run: SqlRunner) => new DatabricksIntrospectionAdapter(run)],
  ])("%s adapter issues only SELECT statements", async (_name, make) => {
    const { statements, run } = capture();
    await drive(make(run));
    expect(statements.length).toBeGreaterThan(0);
    statements.forEach((sql) => expect(sql).toMatch(/^\s*(SELECT|SHOW)\b/i));
    statements.forEach((sql) =>
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i)
    );
  });

  it("escapes single quotes in schema names (literal injection guard)", async () => {
    const { statements, run } = capture();
    const adapter = new PostgresIntrospectionAdapter(run);
    await adapter.listRelations("we'ird");
    expect(statements[0]).toContain("'we''ird'");
  });
});
