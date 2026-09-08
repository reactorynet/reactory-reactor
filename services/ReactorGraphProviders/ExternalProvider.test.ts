import {
  nodeId,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
  sourceLogicalKey,
} from "../graph/GraphIdentity";
import { makeContext } from "../graph/testUtils";
import {
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
  ReactorLinkType,
} from "../../types/model.types";
import {
  IReactorProject,
  ProcessOptions,
} from "../../types/service.types";
import BaseExternalGraphProvider, {
  ExternalEntityBatch,
} from "./BaseExternalGraphProvider";
import ReactorProjectServiceImpl from "../ReactorProjectService";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SITE = "fixture.example.net";

interface FakeTicket {
  key: string;
  summary: string;
  updated: string;
}

/**
 * An in-memory external provider: canned ticket data, persistence captured in
 * maps so the BaseExternalGraphProvider template (batching, incremental skip,
 * GC gating) is exercised without Mongo.
 */
class FakeTicketProvider extends BaseExternalGraphProvider {
  nameSpace = "test";
  name = "FakeTicketProvider";
  version = "1.0.0";

  ticketsByProject: Record<string, FakeTicket[]> = {};
  failAfterFirstBatch = false;

  // in-memory persistence + call capture
  nodesStore = new Map<number, any>();
  edgesStore = new Map<number, any>();
  persistCalls: Array<{ nodes: number; edges: number }> = [];
  indexedSearchables: any[] = [];
  touchedNodeIds: number[] = [];
  gcCalls = 0;

  sourceScheme(): string {
    return "faketickets";
  }

  getProjectTypes(): any[] {
    return ["rest"];
  }

  ticketNodeId(project: Partial<IReactorProject>, projKey: string, ticketKey: string): number {
    return nodeId(sourceLogicalKey("faketickets", this.sourceKeyFor(project), projKey, ticketKey));
  }

  containerNodeId(project: Partial<IReactorProject>, projKey: string): number {
    return nodeId(sourceLogicalKey("faketickets", this.sourceKeyFor(project), projKey));
  }

  async *discoverEntities(
    project: Partial<IReactorProject>,
    _options: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch> {
    const rootId = nodeId(projectLogicalKey(project));
    let batchIndex = 0;
    for (const [projKey, tickets] of Object.entries(this.ticketsByProject)) {
      if (this.failAfterFirstBatch && batchIndex >= 1) {
        throw new Error("remote source went away");
      }
      const containerId = this.containerNodeId(project, projKey);
      const nodes: Partial<ReactorNode>[] = [
        {
          id: containerId,
          index: containerId,
          name: projKey,
          key: `${rootId}|${containerId}`,
          type: ReactorNodeType.CONTAINER,
          parentId: rootId,
          providerId: this.fqn(),
          nameSpace: project.nameSpace,
          version: project.version,
          data: { kind: "ticket-project", projKey },
        },
      ];
      const edges: ReactorNodeLink[] = [];
      const searchables: any[] = [];
      const ticketIds: number[] = [];

      for (const t of tickets) {
        const logicalKey = sourceLogicalKey("faketickets", this.sourceKeyFor(project), projKey, t.key);
        const tid = nodeId(logicalKey);
        ticketIds.push(tid);
        nodes.push({
          id: tid,
          index: tid,
          name: t.key,
          key: `${rootId}|${containerId}|${tid}`,
          type: ReactorNodeType.RESOURCE,
          parentId: containerId,
          providerId: this.fqn(),
          nameSpace: project.nameSpace,
          version: project.version,
          contentHash: `v:${t.updated}`,
          data: { kind: "ticket", ticketKey: t.key, summary: t.summary },
        });
        searchables.push({
          id: logicalKey,
          nodeId: tid,
          name: `${t.key} ${t.summary}`,
          nameSpace: project.nameSpace,
          version: project.version,
          source: t.summary,
          type: { id: "ticket", name: "ticket" },
        });
      }

      // one REFERENCE edge between the first two tickets of a project
      if (ticketIds.length >= 2) {
        edges.push({
          id: nodeId(`${ticketIds[0]}->${ticketIds[1]}:${ReactorLinkType.REFERENCE}`),
          source: ticketIds[0],
          target: ticketIds[1],
          types: [ReactorLinkType.REFERENCE],
          title: "relates",
        } as ReactorNodeLink);
      }

      batchIndex++;
      yield { nodes, edges, searchables };
    }
  }

  // ---- in-memory persistence overrides ------------------------------------

  protected async persistGraph(
    nodes: Partial<ReactorNode>[],
    edges: ReactorNodeLink[],
    meta?: any
  ): Promise<{ ok: boolean; nodeOps: number; edgeOps: number; error?: string }> {
    this.persistCalls.push({ nodes: nodes.length, edges: edges.length });
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

  protected async gcStale(
    projectId: string,
    runId: string
  ): Promise<{ nodesGcDeleted: number; edgesGcDeleted: number; error?: boolean }> {
    this.gcCalls++;
    let nodesGcDeleted = 0;
    let edgesGcDeleted = 0;
    for (const [id, node] of Array.from(this.nodesStore.entries())) {
      if (String(node.projectId) === String(projectId) && node.runId !== runId && node.runId !== "manual") {
        this.nodesStore.delete(id);
        nodesGcDeleted++;
      }
    }
    for (const [id, edge] of Array.from(this.edgesStore.entries())) {
      if (String(edge.projectId) === String(projectId) && edge.runId !== runId && edge.runId !== "manual") {
        this.edgesStore.delete(id);
        edgesGcDeleted++;
      }
    }
    return { nodesGcDeleted, edgesGcDeleted };
  }

  protected async loadPreviousNodes(
    project: Partial<IReactorProject>,
    _types?: ReactorNodeType[] | null
  ): Promise<Map<number, Partial<ReactorNode>>> {
    const m = new Map<number, Partial<ReactorNode>>();
    for (const [id, node] of this.nodesStore.entries()) {
      if (String(node.projectId) === String(project.id)) m.set(id, node);
    }
    return m;
  }

  protected async loadDescendantNodeIds(parentId: number, projectId: string): Promise<number[]> {
    const ids: number[] = [];
    for (const [id, node] of this.nodesStore.entries()) {
      if (String(node.projectId) === String(projectId) && node.parentId === parentId) ids.push(id);
    }
    return ids;
  }

  protected async loadEdgeIdsTouching(nodeIds: number[], projectId: string): Promise<number[]> {
    const ids: number[] = [];
    for (const [id, edge] of this.edgesStore.entries()) {
      if (
        String(edge.projectId) === String(projectId) &&
        (nodeIds.includes(edge.source) || nodeIds.includes(edge.target))
      ) {
        ids.push(id);
      }
    }
    return ids;
  }

  protected async touchNodes(ids: number[], meta: { runId: string; indexedAt: Date }): Promise<void> {
    this.touchedNodeIds.push(...ids);
    ids.forEach((id) => {
      const n = this.nodesStore.get(id);
      if (n) n.runId = meta.runId;
    });
  }

  protected async touchEdges(ids: number[], meta: { runId: string; indexedAt: Date }): Promise<void> {
    ids.forEach((id) => {
      const e = this.edgesStore.get(id);
      if (e) e.runId = meta.runId;
    });
  }

  protected async indexSearchables(_project: Partial<IReactorProject>, searchables: any[]): Promise<void> {
    this.indexedSearchables.push(...searchables);
  }
}

const makeProject = (overrides: Partial<IReactorProject> = {}): Partial<IReactorProject> =>
  ({
    id: "ext-proj-1",
    name: "fixture-tickets",
    nameSpace: "test",
    version: "1.0.0",
    source: { scheme: "faketickets", sourceKey: SITE },
    processors: [{ id: "faketickets", processor: "test.FakeTicketProvider@1.0.0" }],
    projectTypes: ["rest"] as any,
    ...overrides,
  } as Partial<IReactorProject>);

const makeProvider = (tickets?: Record<string, FakeTicket[]>) => {
  const context = makeContext();
  const provider = new FakeTicketProvider({} as any, context);
  provider.ticketsByProject = tickets || {
    WR: [
      { key: "WR-1", summary: "Fix login", updated: "2026-01-01T00:00:00Z" },
      { key: "WR-2", summary: "Add search", updated: "2026-01-02T00:00:00Z" },
    ],
    PAY: [{ key: "PAY-9", summary: "Refund flow", updated: "2026-02-01T00:00:00Z" }],
  };
  return { provider, context };
};

// ---------------------------------------------------------------------------
// sourceLogicalKey
// ---------------------------------------------------------------------------

describe("GraphIdentity.sourceLogicalKey", () => {
  it("builds scheme:sourceKey[/path][#fragment] keys", () => {
    expect(sourceLogicalKey("jira", "site.atlassian.net")).toBe("jira:site.atlassian.net");
    expect(sourceLogicalKey("jira", "site.atlassian.net", "WR")).toBe("jira:site.atlassian.net/WR");
    expect(sourceLogicalKey("jira", "site.atlassian.net", "WR", "WR-123")).toBe(
      "jira:site.atlassian.net/WR#WR-123"
    );
    expect(sourceLogicalKey("db", "sales-dwh", "dbo/orders", "customer_id")).toBe(
      "db:sales-dwh/dbo/orders#customer_id"
    );
  });

  it("normalises entity paths (backslashes, leading ./)", () => {
    expect(sourceLogicalKey("db", "conn", ".\\dbo\\orders")).toBe("db:conn/dbo/orders");
  });

  it("is a pure function of the reference (stable ids)", () => {
    const a = nodeId(sourceLogicalKey("jira", "s.net", "WR", "WR-1"));
    const b = nodeId(sourceLogicalKey("jira", "s.net", "WR", "WR-1"));
    expect(a).toBe(b);
  });

  it("does not collide with the filesystem logical key space", () => {
    // a repo file 'jira:site/WR.md' style paths are prefixed by fqn + '::' so
    // the two key spaces cannot alias each other.
    const external = sourceLogicalKey("jira", "site", "WR", "WR-1");
    const fsKey = pathLogicalKey("test.fixture@1.0.0", "jira:site/WR#WR-1");
    expect(external).not.toBe(fsKey);
    expect(fsKey).toContain("::");
    expect(external).not.toContain("::");
  });
});

// ---------------------------------------------------------------------------
// BaseExternalGraphProvider template
// ---------------------------------------------------------------------------

describe("BaseExternalGraphProvider — snapshot pipeline", () => {
  it("supportsProject matches only its own source scheme (no fs, no network)", () => {
    const { provider } = makeProvider();
    expect(provider.supportsProject(makeProject())).toBe(true);
    expect(provider.supportsProject(makeProject({ source: { scheme: "db", sourceKey: "x" } }))).toBe(false);
    expect(provider.supportsProject({ repoPath: "/tmp/somewhere" })).toBe(false);
    expect(provider.supportsProject({})).toBe(false);
  });

  it("builds root + entities with deterministic sourceLogicalKey ids, persisted per batch", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);

    const rootId = nodeId(projectLogicalKey(project));
    expect(provider.nodesStore.has(rootId)).toBe(true);

    const wrContainer = provider.containerNodeId(project, "WR");
    const wr1 = provider.ticketNodeId(project, "WR", "WR-1");
    const pay9 = provider.ticketNodeId(project, "PAY", "PAY-9");
    expect(provider.nodesStore.get(wrContainer)?.parentId).toBe(rootId);
    expect(provider.nodesStore.get(wr1)?.parentId).toBe(wrContainer);
    expect(provider.nodesStore.get(pay9)?.data?.ticketKey).toBe("PAY-9");

    // root persist + one persist per batch (2 project keys = 2 batches)
    expect(provider.persistCalls.length).toBe(3);

    // edge between WR-1 and WR-2 stamped with projectId
    const edges = Array.from(provider.edgesStore.values());
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(wr1);
    expect(edges[0].projectId).toBe("ext-proj-1");

    // searchables carry nodeId matching the graph node ids
    const searchableNodeIds = provider.indexedSearchables.map((s) => s.nodeId);
    expect(searchableNodeIds).toContain(wr1);
    expect(searchableNodeIds).toContain(pay9);

    // metrics emitted
    expect(provider.lastMetrics?.filesDiscovered).toBe(5); // 2 containers + 3 tickets
    expect(provider.lastMetrics?.errors).toBe(0);
  });

  it("is idempotent: a second identical run produces the same ids and GCs nothing", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);
    const idsAfterFirst = new Set(provider.nodesStore.keys());

    await provider.process(project);
    const idsAfterSecond = new Set(provider.nodesStore.keys());
    expect(idsAfterSecond).toEqual(idsAfterFirst);
    expect(provider.gcCalls).toBe(2);
  });

  it("GCs entities that disappear from the source on the next run", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);
    const wr2 = provider.ticketNodeId(project, "WR", "WR-2");
    expect(provider.nodesStore.has(wr2)).toBe(true);

    // WR-2 removed at the source
    provider.ticketsByProject.WR = provider.ticketsByProject.WR.filter((t) => t.key !== "WR-2");
    await provider.process(project);
    expect(provider.nodesStore.has(wr2)).toBe(false);
    // the others survive
    expect(provider.nodesStore.has(provider.ticketNodeId(project, "WR", "WR-1"))).toBe(true);
    expect(provider.nodesStore.has(provider.ticketNodeId(project, "PAY", "PAY-9"))).toBe(true);
  });

  it("skips unchanged entities by contentHash (no re-persist, no re-index, runId touched)", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);
    provider.indexedSearchables = [];
    provider.touchedNodeIds = [];

    // WR-1 updated at the source; the rest unchanged
    provider.ticketsByProject.WR[0].updated = "2026-03-01T00:00:00Z";
    await provider.process(project);

    const wr1 = provider.ticketNodeId(project, "WR", "WR-1");
    const wr2 = provider.ticketNodeId(project, "WR", "WR-2");
    const pay9 = provider.ticketNodeId(project, "PAY", "PAY-9");

    // changed ticket re-indexed; unchanged not
    const reindexed = provider.indexedSearchables.map((s) => s.nodeId);
    expect(reindexed).toContain(wr1);
    expect(reindexed).not.toContain(wr2);
    expect(reindexed).not.toContain(pay9);

    // unchanged were touched with the new runId (GC preservation)
    expect(provider.touchedNodeIds).toContain(wr2);
    expect(provider.touchedNodeIds).toContain(pay9);
    expect(provider.touchedNodeIds).not.toContain(wr1);

    expect(provider.lastMetrics?.filesSkipped).toBe(2);
    // containers have no contentHash so they always re-persist
    expect(provider.lastMetrics?.filesAnalysed).toBe(3); // 2 containers + WR-1
  });

  it("forceFull bypasses the contentHash skip", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);
    provider.indexedSearchables = [];
    await provider.process(project, { forceFull: true });
    expect(provider.lastMetrics?.filesSkipped).toBe(0);
    expect(provider.indexedSearchables.length).toBe(3);
  });

  it("does NOT GC on a partial snapshot (discovery error mid-run)", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    await provider.process(project);
    expect(provider.gcCalls).toBe(1);
    const nodeCount = provider.nodesStore.size;

    provider.failAfterFirstBatch = true;
    const result = await provider.process(project);
    expect(result).toBeTruthy(); // resilient: returns the project, no throw
    expect(provider.gcCalls).toBe(1); // unchanged - GC skipped
    expect(provider.nodesStore.size).toBe(nodeCount); // nothing deleted
    expect(provider.lastMetrics?.errors).toBeGreaterThan(0);
  });

  it("honours skipGc for orchestrated multi-processor runs", async () => {
    const { provider } = makeProvider();
    await provider.process(makeProject(), { skipGc: true });
    expect(provider.gcCalls).toBe(0);
  });

  it("root node source points at the source spec, not a repoPath", async () => {
    const { provider } = makeProvider();
    const project = makeProject();
    const root = await provider.getProjectNode(project);
    expect(root.source).toBe(`faketickets:${SITE}`);
  });

  it("getFileSpecs returns no filesystem specs for an external source", () => {
    const { provider } = makeProvider();
    expect(provider.getFileSpecs(makeProject())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registered-source detection (ReactorProjectService)
// ---------------------------------------------------------------------------

describe("ReactorProjectService — registered external sources", () => {
  const makeServiceContext = () => {
    const context = makeContext();
    context.partner = undefined;
    context.warn = jest.fn();
    context.info = jest.fn();
    context.error = jest.fn();
    return context;
  };

  it("detectProjectProcessors returns configured processors verbatim for repoPath-less projects", async () => {
    const service = new ReactorProjectServiceImpl({} as any, makeServiceContext());
    const project = makeProject();
    const detected = await service.detectProjectProcessors(project);
    expect(detected).toEqual([
      { id: "faketickets", processor: "test.FakeTicketProvider@1.0.0" },
    ]);
  });

  it("never runs filesystem probes for repoPath-less configured projects", async () => {
    const service = new ReactorProjectServiceImpl({} as any, makeServiceContext());
    const probeSpies = Object.values((service as any).processors).map((p: any) =>
      jest.spyOn(p, "supportsProject")
    );
    await service.detectProjectProcessors(makeProject());
    probeSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it("isolates a throwing probe instead of failing detection", async () => {
    const context = makeServiceContext();
    const service = new ReactorProjectServiceImpl({} as any, context);
    const processors = (service as any).processors;
    const firstKey = Object.keys(processors).find(
      (k) => k !== "file"
    ) as string;
    jest.spyOn(processors[firstKey], "supportsProject").mockImplementation(() => {
      throw new Error("boom");
    });
    // a project with a repoPath goes down the probe loop
    const detected = await service.detectProjectProcessors({
      name: "x",
      nameSpace: "test",
      version: "1.0.0",
      repoPath: "/tmp/does-not-exist-xyz",
    } as any);
    expect(Array.isArray(detected)).toBe(true);
    expect(context.warn).toHaveBeenCalled();
  });

  it("processProject rejects a project with neither repoPath nor source", async () => {
    const service = new ReactorProjectServiceImpl({} as any, makeServiceContext());
    await expect(
      service.processProject({ name: "x", nameSpace: "test", version: "1.0.0" } as any)
    ).rejects.toThrow(/repoPath or source/);
  });
});
