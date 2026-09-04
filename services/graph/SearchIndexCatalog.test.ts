import SystemGraphManager from "../SystemGraphManager";
import BaseExternalGraphProvider, { ExternalEntityBatch } from "../ReactorGraphProviders/BaseExternalGraphProvider";
import { ReactorProjectModel } from "../../models/ReactorProject";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";
import {
  clearModuleSearchIndexes,
  registerModuleSearchIndexes,
} from "./searchIndexCatalog";
import { nodeId } from "./GraphIdentity";
import { ReactorNodeType } from "../../types/model.types";
import { IReactorProject, ProcessOptions } from "../../types/service.types";

const makeContext = (services: Record<string, any> = {}) => {
  const store = new Map<string, any>();
  const svc = new Map<string, any>(Object.entries(services));
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: (id: string) => svc.get(id) || null,
    utils: { hash: (v: any) => nodeId(String(v)) },
  } as any;
};

describe("Session 08 — search index catalog", () => {
  const projects = [
    {
      _id: "p1",
      name: "app-client",
      nameSpace: "reactor",
      version: "1.0.0",
      fqn: "reactor.app-client@1.0.0",
      description: "The client app",
      lastSync: new Date("2026-09-01T00:00:00Z"),
    },
    {
      _id: "p2",
      name: "worldremit",
      nameSpace: "jira",
      version: "1.0.0",
      fqn: "jira.worldremit@1.0.0",
      source: { scheme: "jira", sourceKey: "x.net" },
    },
    {
      _id: "p3",
      name: "other-tenant-app",
      nameSpace: "reactor",
      version: "1.0.0",
      client: "partner-B",
    },
  ];

  beforeEach(() => {
    jest.restoreAllMocks();
    clearModuleSearchIndexes();
    jest.spyOn(ReactorProjectModel, "find").mockReturnValue({
      select: () => ({ lean: async () => projects }),
      lean: async () => projects,
    } as any);
  });

  it("builds project entries and annotates from the backend listing without adding raw entries", async () => {
    const listIndexes = jest.fn().mockResolvedValue([
      { name: "reactor_graph_reactor_app-client", documentCount: 42 },
      { name: "reactor_graph_someone_elses_index", documentCount: 999 }, // must NOT appear
    ]);
    const ctx = makeContext();
    const manager = new SystemGraphManager({} as any, ctx);
    (manager as any).searchService = { listIndexes };

    const catalog = await manager.getSearchIndexCatalog();
    const names = catalog.map((e) => e.index);

    expect(names).toContain("reactor_graph_reactor_app-client");
    expect(names).toContain("reactor_graph_jira_worldremit");
    expect(names).not.toContain("reactor_graph_someone_elses_index"); // raw listing never adds

    const appEntry = catalog.find((e) => e.index === "reactor_graph_reactor_app-client")!;
    expect(appEntry.documentCount).toBe(42);
    expect(appEntry.exists).toBe(true);
    expect(appEntry.description).toBe("The client app");

    const jiraEntry = catalog.find((e) => e.index === "reactor_graph_jira_worldremit")!;
    expect(jiraEntry.exists).toBe(false); // registered but not yet built
    expect(jiraEntry.description).toContain("jira source");
  });

  it("filters by partnerId with safe fallback for records without a client", async () => {
    const ctx = makeContext();
    const manager = new SystemGraphManager({} as any, ctx);
    (manager as any).searchService = {};
    const catalog = await manager.getSearchIndexCatalog({ partnerId: "partner-A" });
    const names = catalog.map((e) => e.index);
    expect(names).toContain("reactor_graph_reactor_app-client"); // no client → visible
    expect(names).not.toContain("reactor_graph_reactor_other-tenant-app"); // partner-B → hidden
  });

  it("includes module-registered indexes and tolerates a backend without listIndexes", async () => {
    registerModuleSearchIndexes([
      { index: "book-catalog", title: "BookTutor catalog", description: "Books" },
    ]);
    const ctx = makeContext();
    const manager = new SystemGraphManager({} as any, ctx);
    (manager as any).searchService = {}; // no listIndexes capability
    const catalog = await manager.getSearchIndexCatalog();
    const entry = catalog.find((e) => e.index === "book-catalog")!;
    expect(entry.kind).toBe("module");
    expect(entry.exists).toBeUndefined(); // unknown — capability absent
  });
});

// ---------------------------------------------------------------------------
// GC parity — deleted nodes drop their search documents
// ---------------------------------------------------------------------------

class GcProbeProvider extends BaseExternalGraphProvider {
  nameSpace = "test";
  name = "GcProbeProvider";
  version = "1.0.0";
  sourceScheme() {
    return "gcprobe";
  }
  getProjectTypes(): any[] {
    return [];
  }
  async *discoverEntities(
    _p: Partial<IReactorProject>,
    _o: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch> {
    /* not used */
  }
  // expose for the test
  public gc(projectId: string, runId: string, opts?: any) {
    return this.gcStale(projectId, runId, opts);
  }
}

describe("Session 08 — GC search parity", () => {
  beforeEach(() => jest.restoreAllMocks());

  const doomed = [
    {
      id: 1,
      type: ReactorNodeType.FILE,
      projectFqn: "test.app@1.0.0",
      data: { relativePath: "src/deleted.ts" },
    },
    {
      id: 2,
      type: ReactorNodeType.TICKET,
      data: { searchId: "jira:x.net/WR#WR-9" },
    },
    { id: 3, type: ReactorNodeType.FOLDER, data: {} }, // never indexed → no searchable id
  ];

  const mockGcModels = () => {
    jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
      select: () => ({ lean: async () => doomed }),
      lean: async () => doomed,
    } as any);
    jest.spyOn(ReactorNodeModel, "deleteMany").mockResolvedValue({ deletedCount: 3 } as any);
    jest.spyOn(ReactorNodeLinkModel, "deleteMany").mockResolvedValue({ deletedCount: 1 } as any);
  };

  it("deletes search documents for GC'd nodes by logical key", async () => {
    mockGcModels();
    const deleteDocuments = jest.fn().mockResolvedValue({});
    const ctx = makeContext({ "core.ReactorySearchService@1.0.0": { deleteDocuments } });
    const provider = new GcProbeProvider({} as any, ctx);

    const result = await provider.gc("proj-1", "run-2", {
      searchIndexName: "reactor_graph_test_app",
    });

    expect(result.nodesGcDeleted).toBe(3);
    expect(result.searchablesDeleted).toBe(2);
    expect(deleteDocuments).toHaveBeenCalledWith("reactor_graph_test_app", [
      "test.app@1.0.0::src/deleted.ts", // reconstructed for FILE nodes
      "jira:x.net/WR#WR-9", // provider-stamped data.searchId
    ]);
  });

  it("warns and continues when the backend lacks deleteDocuments", async () => {
    mockGcModels();
    const ctx = makeContext({ "core.ReactorySearchService@1.0.0": {} });
    const provider = new GcProbeProvider({} as any, ctx);
    const result = await provider.gc("proj-1", "run-2", {
      searchIndexName: "reactor_graph_test_app",
    });
    expect(result.nodesGcDeleted).toBe(3);
    expect(result.searchablesDeleted).toBe(0);
    expect(ctx.warn).toHaveBeenCalled();
  });

  it("skips searchable collection entirely when no index name is passed", async () => {
    mockGcModels();
    const findSpy = ReactorNodeModel.find as jest.Mock;
    const ctx = makeContext();
    const provider = new GcProbeProvider({} as any, ctx);
    await provider.gc("proj-1", "run-2");
    expect(findSpy).not.toHaveBeenCalled(); // no pre-delete collection query
  });
});
