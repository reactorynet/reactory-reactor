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
import JiraGraphProvider, { IJiraReader } from "./JiraGraphProvider";

const SITE = "fixture.atlassian.net";
const READER_FQN = "atlassian.JiraReaderService@1.0.0";

// ---------------------------------------------------------------------------
// Fixture data (2 projects, 5 tickets, 1 board, 2 sprints, mixed links)
// ---------------------------------------------------------------------------

const user = (accountId: string, displayName: string) => ({
  accountId,
  displayName,
  active: true,
});

const issue = (key: string, overrides: any = {}): any => ({
  id: key,
  key,
  self: `https://${SITE}/rest/api/3/issue/${key}`,
  summary: `Summary of ${key}`,
  description: `Description of ${key}`,
  status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  project: { id: "1", key: key.split("-")[0], name: key.split("-")[0], projectTypeKey: "software" },
  issueType: { id: "10001", name: "Task", description: "", subtask: false },
  labels: ["auth"],
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-05T00:00:00.000Z",
  ...overrides,
});

const makeFixture = () => ({
  WR: [
    issue("WR-1", {
      assignee: user("acc-alice", "Alice Example"),
      issueLinks: [
        { id: "l1", typeName: "Blocks", direction: "outward", otherIssueKey: "WR-2" },
      ],
      sprints: [{ id: 11, name: "Sprint 11", state: "active", boardId: 7 }],
    }),
    issue("WR-2", {
      issueLinks: [
        // the same physical link seen from the other side — must dedupe to one edge
        { id: "l1", typeName: "Blocks", direction: "inward", otherIssueKey: "WR-1" },
      ],
    }),
    issue("WR-3", {
      issueLinks: [
        { id: "l2", typeName: "Relates", direction: "outward", otherIssueKey: "EXT-9", otherIssueSummary: "External thing" },
      ],
      parent: { id: "99", key: "WR-99", issueTypeName: "Epic" },
    }),
    issue("WR-4"),
  ],
  PAY: [
    issue("PAY-9", {
      issueLinks: [
        { id: "l3", typeName: "Cloners", direction: "outward", otherIssueKey: "WR-1" },
      ],
    }),
  ],
});

class MockJiraReader implements IJiraReader {
  fixture = makeFixture();
  searchCalls: Array<{ jql: string; startAt: number; maxResults: number }> = [];
  configureCalls: Array<{ settingKey?: string; host?: string } | null | undefined> = [];

  configureSource(opts?: { settingKey?: string; host?: string } | null) {
    this.configureCalls.push(opts);
  }

  async searchIssues(jql: string, startAt = 0, maxResults = 50) {
    this.searchCalls.push({ jql, startAt, maxResults });
    const key = /project = (\w+)/.exec(jql)?.[1] as keyof ReturnType<typeof makeFixture>;
    const all = this.fixture[key] || [];
    const page = all.slice(startAt, startAt + maxResults);
    return {
      issues: page,
      total: all.length,
      isLast: startAt + page.length >= all.length,
    };
  }

  async getBoards(projectKeyOrName?: string) {
    if (projectKeyOrName === "WR") {
      return [
        { id: 7, name: "WR board", type: "scrum", location: { projectKey: "WR" } },
        { id: 8, name: "Other project board", type: "scrum", location: { projectKey: "ZZZ" } },
      ];
    }
    return [];
  }

  async getSprints(boardId: number) {
    if (boardId !== 7) return [];
    return [
      { id: 11, name: "Sprint 11", state: "active", originBoardId: 7 },
      { id: 12, name: "Sprint 12", state: "future", originBoardId: 7 },
    ];
  }
}

// ---------------------------------------------------------------------------
// In-memory persistence harness (same approach as ExternalProvider.test.ts)
// ---------------------------------------------------------------------------

class TestableJiraProvider extends JiraGraphProvider {
  nodesStore = new Map<number, any>();
  edgesStore = new Map<number, any>();
  indexedSearchables: any[] = [];
  touchedNodeIds: number[] = [];
  gcCalls = 0;

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
      ) {
        ids.push(id);
      }
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

  protected async indexSearchables(_project: Partial<IReactorProject>, searchables: any[]) {
    this.indexedSearchables.push(...searchables);
  }
}

const makeProject = (options: any = {}): Partial<IReactorProject> =>
  ({
    id: "jira-proj-1",
    name: "fixture-jira",
    nameSpace: "jira",
    version: "1.0.0",
    source: {
      scheme: "jira",
      sourceKey: SITE,
      options: { projectKeys: ["WR", "PAY"], ...options },
    },
    processors: [{ id: "jira", processor: "reactor.JiraGraphProvider@1.0.0" }],
    projectTypes: ["rest"] as any,
  } as Partial<IReactorProject>);

const setup = (options: any = {}) => {
  const context = makeContext();
  context.warn = jest.fn();
  context.info = jest.fn();
  context.error = jest.fn();
  const reader = new MockJiraReader();
  const services = new Map<string, any>([[READER_FQN, reader]]);
  context.getService = (id: string) => services.get(id) || null;
  const provider = new TestableJiraProvider({} as any, context);
  const project = makeProject(options);
  return { provider, project, reader, context };
};

const tid = (project: Partial<IReactorProject>, key: string) =>
  nodeId(sourceLogicalKey("jira", SITE, key.split("-")[0], key));
const cid = (key: string) => nodeId(sourceLogicalKey("jira", SITE, key));
const bid = (projectKey: string, boardId: number) =>
  nodeId(sourceLogicalKey("jira", SITE, `${projectKey}/boards`, String(boardId)));
const sid = (projectKey: string, boardId: number, sprintId: number) =>
  nodeId(sourceLogicalKey("jira", SITE, `${projectKey}/boards/${boardId}`, `sprint-${sprintId}`));

describe("JiraGraphProvider — snapshot", () => {
  it("supportsProject only for jira source scheme (no network, no fs)", () => {
    const { provider } = setup();
    expect(provider.supportsProject(makeProject())).toBe(true);
    expect(provider.supportsProject({ source: { scheme: "db", sourceKey: "x" } } as any)).toBe(false);
    expect(provider.supportsProject({ repoPath: "/tmp" } as any)).toBe(false);
  });

  it("builds the project/board/sprint/ticket/person tree with deterministic ids", async () => {
    const { provider, project } = setup();
    await provider.process(project);

    const rootId = nodeId(projectLogicalKey(project));
    // containers
    expect(provider.nodesStore.get(cid("WR"))?.parentId).toBe(rootId);
    expect(provider.nodesStore.get(cid("WR"))?.type).toBe(ReactorNodeType.CONTAINER);
    // tickets
    const wr1 = provider.nodesStore.get(tid(project, "WR-1"));
    expect(wr1?.parentId).toBe(cid("WR"));
    expect(wr1?.type).toBe(ReactorNodeType.TICKET);
    expect(wr1?.data?.url).toBe(`https://${SITE}/browse/WR-1`);
    expect(wr1?.data?.status).toBe("To Do");
    // board (only the WR-located board; the ZZZ board is filtered)
    expect(provider.nodesStore.get(bid("WR", 7))?.type).toBe(ReactorNodeType.BOARD);
    expect(provider.nodesStore.get(bid("WR", 8))).toBeUndefined();
    // sprints under the board — full nodes (board phase overwrote the issue-phase stub)
    const sprint11 = provider.nodesStore.get(sid("WR", 7, 11));
    expect(sprint11?.parentId).toBe(bid("WR", 7));
    expect(sprint11?.type).toBe(ReactorNodeType.SPRINT);
    expect(sprint11?.data?.stub).toBeUndefined();
    expect(sprint11?.data?.state).toBe("active");
    expect(provider.nodesStore.get(sid("WR", 7, 12))?.data?.state).toBe("future");
    // person, source-scoped under the root, no email
    const alice = provider.nodesStore.get(nodeId(sourceLogicalKey("jira", SITE, undefined, "person:acc-alice")));
    expect(alice?.type).toBe(ReactorNodeType.PERSON);
    expect(alice?.parentId).toBe(rootId);
    expect(JSON.stringify(alice)).not.toContain("emailAddress");
  });

  it("maps issue links to typed edges, deduped across both link ends", async () => {
    const { provider, project } = setup();
    await provider.process(project);

    const edges = Array.from(provider.edgesStore.values());
    const blocks = edges.filter((e) => e.types.includes(ReactorLinkType.BLOCKS));
    expect(blocks).toHaveLength(1); // WR-1 outward + WR-2 inward = one deterministic edge
    expect(blocks[0].source).toBe(tid(project, "WR-1"));
    expect(blocks[0].target).toBe(tid(project, "WR-2"));

    const dup = edges.filter((e) => e.types.includes(ReactorLinkType.DUPLICATES));
    expect(dup).toHaveLength(1); // PAY-9 Cloners → WR-1 (cross-project, in-scope: no stub)
    expect(dup[0].source).toBe(tid(project, "PAY-9"));
    expect(dup[0].target).toBe(tid(project, "WR-1"));

    const relates = edges.filter((e) => e.types.includes(ReactorLinkType.RELATES));
    expect(relates).toHaveLength(1);
    expect(relates[0].target).toBe(tid(project, "EXT-9"));
  });

  it("creates stub nodes for out-of-scope link targets (P6) and never for in-scope ones", async () => {
    const { provider, project } = setup();
    await provider.process(project);

    const ext9 = provider.nodesStore.get(tid(project, "EXT-9"));
    expect(ext9?.data?.stub).toBe(true);
    expect(ext9?.data?.url).toBe(`https://${SITE}/browse/EXT-9`);
    // the epic parent WR-99 (in-scope prefix, not enumerated) also stubs
    expect(provider.nodesStore.get(tid(project, "WR-99"))?.data?.stub).toBe(true);
    // WR-1 was fully enumerated before PAY linked to it — still a full node
    expect(provider.nodesStore.get(tid(project, "WR-1"))?.data?.stub).toBeUndefined();
    // stubs are not indexed for search
    const indexedIds = provider.indexedSearchables.map((s) => s.nodeId);
    expect(indexedIds).not.toContain(tid(project, "EXT-9"));
    expect(indexedIds).not.toContain(tid(project, "WR-99"));
  });

  it("emits PART_OF membership edges (sprint, board, parent epic) and ASSIGNED_TO", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const edges = Array.from(provider.edgesStore.values());
    const partOf = edges.filter((e) => e.types.includes(ReactorLinkType.PART_OF));
    const targets = partOf.map((e) => [e.source, e.target]);
    expect(targets).toContainEqual([tid(project, "WR-1"), sid("WR", 7, 11)]);
    expect(targets).toContainEqual([tid(project, "WR-1"), bid("WR", 7)]);
    expect(targets).toContainEqual([tid(project, "WR-3"), tid(project, "WR-99")]);
    const assigned = edges.filter((e) => e.types.includes(ReactorLinkType.ASSIGNED_TO));
    expect(assigned).toHaveLength(1);
    expect(assigned[0].source).toBe(tid(project, "WR-1"));
  });

  it("indexes ticket searchables with graph-aligned nodeIds; comments stay out unless opted in", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const wr1Searchable = provider.indexedSearchables.find((s) => s.nodeId === tid(project, "WR-1"));
    expect(wr1Searchable).toBeTruthy();
    expect(wr1Searchable.id).toBe(sourceLogicalKey("jira", SITE, "WR", "WR-1"));
    expect(wr1Searchable.name).toBe("WR-1 Summary of WR-1");
    expect(wr1Searchable.source).toContain("Description of WR-1");
    expect(wr1Searchable.source).toContain("auth"); // labels
    expect(provider.indexedSearchables).toHaveLength(5);
  });

  it("pages through issues respecting pageSize", async () => {
    const { provider, project, reader } = setup({ pageSize: 2 });
    await provider.process(project);
    const wrCalls = reader.searchCalls.filter((c) => c.jql.includes("project = WR"));
    expect(wrCalls.length).toBe(2); // 4 issues / pageSize 2
    expect(provider.nodesStore.get(tid(project, "WR-4"))).toBeTruthy();
  });

  it("logs truncation when maxIssuesPerProject caps the snapshot (P4: no silent caps)", async () => {
    const { provider, project, context } = setup({ maxIssuesPerProject: 2 });
    await provider.process(project);
    expect(provider.nodesStore.get(tid(project, "WR-3"))).toBeUndefined();
    expect(
      (context.warn as jest.Mock).mock.calls.some((c: any[]) => String(c[0]).includes("truncated"))
    ).toBe(true);
  });

  it("is idempotent and GCs tickets removed at the source", async () => {
    const { provider, project, reader } = setup();
    await provider.process(project);
    const first = new Set(provider.nodesStore.keys());
    await provider.process(project);
    expect(new Set(provider.nodesStore.keys())).toEqual(first);

    reader.fixture.WR = reader.fixture.WR.filter((i: any) => i.key !== "WR-4");
    await provider.process(project);
    expect(provider.nodesStore.get(tid(project, "WR-4"))).toBeUndefined();
    expect(provider.nodesStore.get(tid(project, "WR-1"))).toBeTruthy();
  });

  it("skips unchanged tickets by contentHash and re-analyses updated ones", async () => {
    const { provider, project, reader } = setup();
    await provider.process(project);
    provider.indexedSearchables = [];

    reader.fixture.WR[0] = { ...reader.fixture.WR[0], updated: "2026-02-01T00:00:00.000Z" };
    await provider.process(project);

    const reindexed = provider.indexedSearchables.map((s) => s.nodeId);
    expect(reindexed).toContain(tid(project, "WR-1"));
    expect(reindexed).not.toContain(tid(project, "WR-2"));
    expect(provider.touchedNodeIds).toContain(tid(project, "WR-2"));
    expect(provider.lastMetrics?.filesSkipped).toBe(4); // WR-2..4 + PAY-9
  });

  it("fails safe: no projectKeys → error recorded, no GC", async () => {
    const { provider, project } = setup();
    (project.source as any).options = {};
    await provider.process(project);
    expect(provider.gcCalls).toBe(0);
    expect(provider.lastMetrics?.errors).toBeGreaterThan(0);
  });

  it("fails safe: reader unavailable → error recorded, no GC, no throw", async () => {
    const { provider, project, context } = setup();
    context.getService = () => null;
    await provider.process(project);
    expect(provider.gcCalls).toBe(0);
    expect(provider.lastMetrics?.errors).toBeGreaterThan(0);
  });

  it("pins the reader to the source's site + settingKey before discovery", async () => {
    const { provider, project, reader } = setup();
    (project.source as any).settingKey = "jira_site_b";
    await provider.process(project);
    expect(reader.configureCalls).toHaveLength(1);
    expect(reader.configureCalls[0]).toEqual({ settingKey: "jira_site_b", host: SITE });
  });

  it("an unresolvable settingKey aborts the run fail-safe (no GC)", async () => {
    const { provider, project, reader } = setup();
    await provider.process(project);
    expect(provider.gcCalls).toBe(1);
    reader.configureSource = () => {
      throw new Error("setting 'ghost' does not resolve");
    };
    (project.source as any).settingKey = "ghost";
    await provider.process(project);
    expect(provider.gcCalls).toBe(1); // unchanged — GC skipped on the failed run
    expect(provider.lastMetrics?.errors).toBeGreaterThan(0);
  });

  it("persists no credentials or emails anywhere (P2)", async () => {
    const { provider, project } = setup();
    await provider.process(project);
    const everything = JSON.stringify([
      ...provider.nodesStore.values(),
      ...provider.edgesStore.values(),
      ...provider.indexedSearchables,
    ]);
    ["apiToken", "ATLASSIAN_API_TOKEN", "Authorization", "emailAddress", "password"].forEach((secret) =>
      expect(everything).not.toContain(secret)
    );
  });
});
