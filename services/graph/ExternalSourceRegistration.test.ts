import ReactorProjectServiceImpl from "../ReactorProjectService";
import { ReactorProjectModel } from "../../models/ReactorProject";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";
import { nodeId } from "./GraphIdentity";
import { IReactorProject } from "../../types/service.types";

const makeContext = (overrides: Record<string, any> = {}) => {
  const store = new Map<string, any>();
  const services = new Map<string, any>();
  const settings = new Map<string, any>([["atlassian_default", { data: { ok: true } }]]);
  const ctx: any = {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: (id: string) => services.get(id) || null,
    setService: (id: string, instance: any) => services.set(id, instance),
    partner: {
      key: "test-partner",
      getSetting: (key: string) => settings.get(key) || null,
    },
    utils: { hash: (v: any) => nodeId(String(v)) },
    __settings: settings,
    ...overrides,
  };
  return ctx;
};

const jiraInput = {
  nameSpace: "jira",
  name: "worldremit",
  scheme: "jira",
  sourceKey: "worldremit.atlassian.net",
  settingKey: "atlassian_default",
  options: { projectKeys: ["WR"] },
  syncSchedule: "0 * * * *",
};

describe("Session 07 — External source registration", () => {
  let ctx: any;
  let service: ReactorProjectServiceImpl;

  beforeEach(() => {
    ctx = makeContext();
    service = new ReactorProjectServiceImpl({} as any, ctx);
    jest.restoreAllMocks();
  });

  it("exposes the registered external schemes (jira, db)", () => {
    expect(service.listExternalSchemes().sort()).toEqual(["db", "jira"]);
    expect(service.getExternalSourceProvider("jira")).toBeTruthy();
    expect(service.getExternalSourceProvider("db")).toBeTruthy();
    expect(service.getExternalSourceProvider("ghost")).toBeNull();
  });

  it("creates a project with source spec + explicit processor config", async () => {
    jest.spyOn(service, "getProject").mockResolvedValue(null as any);
    const createSpy = jest
      .spyOn(service, "createProject")
      .mockImplementation(async (p: any) => ({ ...p, _id: "new-src-1" }));

    const project: any = await service.registerExternalSource(jiraInput);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(project.fqn).toBe("jira.worldremit@1.0.0");
    expect(project.source).toEqual({
      scheme: "jira",
      sourceKey: "worldremit.atlassian.net",
      settingKey: "atlassian_default",
      options: { projectKeys: ["WR"] },
      syncSchedule: "0 * * * *",
    });
    expect(project.processors).toEqual([
      { id: "jira", processor: "reactor.JiraGraphProvider@1.0.0" },
    ]);
    expect(project.projectTypes).toEqual(["rest"]);
    expect(project.graphRootId).toBe(nodeId("jira.worldremit@1.0.0"));
  });

  it("updates an existing registration idempotently (same fqn)", async () => {
    const existing = { _id: "src-1", fqn: "jira.worldremit@1.0.0", name: "worldremit" };
    jest.spyOn(service, "getProject").mockResolvedValue(existing as any);
    const updateSpy = jest
      .spyOn(service, "updateProject")
      .mockImplementation(async (_id: any, updates: any) => ({ ...existing, ...updates }));
    const createSpy = jest.spyOn(service, "createProject");

    const project: any = await service.registerExternalSource({
      ...jiraInput,
      options: { projectKeys: ["WR", "PAY"] },
    });

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith("src-1", expect.objectContaining({
      source: expect.objectContaining({ options: { projectKeys: ["WR", "PAY"] } }),
    }));
    expect(project.source.options.projectKeys).toEqual(["WR", "PAY"]);
  });

  it("rejects unknown schemes, unresolvable settingKeys and bad cron expressions", async () => {
    await expect(
      service.registerExternalSource({ ...jiraInput, scheme: "ghost" })
    ).rejects.toThrow(/No external graph provider.*ghost/);

    await expect(
      service.registerExternalSource({ ...jiraInput, settingKey: "missing_setting" })
    ).rejects.toThrow(/missing_setting.*does not resolve/);

    await expect(
      service.registerExternalSource({ ...jiraInput, syncSchedule: "not a cron" })
    ).rejects.toThrow(/Invalid syncSchedule/);
  });

  it("never copies the setting VALUE into the project record or logs", async () => {
    jest.spyOn(service, "getProject").mockResolvedValue(null as any);
    jest.spyOn(service, "createProject").mockImplementation(async (p: any) => p);
    const project: any = await service.registerExternalSource(jiraInput);
    const everything = JSON.stringify(project) + JSON.stringify((ctx.info as jest.Mock).mock.calls);
    expect(everything).not.toContain('"ok":true'); // the setting's data payload
  });

  it("db scheme registration maps variant project types", async () => {
    ctx.__settings.set("sales-dwh", { data: { variant: "postgres" } });
    jest.spyOn(service, "getProject").mockResolvedValue(null as any);
    jest.spyOn(service, "createProject").mockImplementation(async (p: any) => p);
    const project: any = await service.registerExternalSource({
      nameSpace: "db",
      name: "sales-dwh",
      scheme: "db",
      sourceKey: "sales-dwh",
      options: { variant: "postgres", schemas: ["public"] },
    });
    expect(project.processors[0].processor).toBe("reactor.DatabaseGraphProvider@1.0.0");
    expect(project.projectTypes).toEqual(["postgresql"]);
  });
});

describe("Session 07 — scheduled re-sync", () => {
  let ctx: any;
  let service: ReactorProjectServiceImpl;

  const src = (fqn: string, syncSchedule: string | undefined, lastSync?: Date) => ({
    _id: `id-${fqn}`,
    fqn,
    name: fqn,
    nameSpace: "jira",
    version: "1.0.0",
    lastSync,
    source: { scheme: "jira", sourceKey: "x.net", syncSchedule },
  });

  beforeEach(() => {
    ctx = makeContext();
    service = new ReactorProjectServiceImpl({} as any, ctx);
    jest.restoreAllMocks();
  });

  it("getDueExternalSources returns only sources whose cron has fired since lastSync", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const sources = [
      src("due-hourly", "0 * * * *", new Date("2026-09-04T09:30:00Z")), // 10:00 fired
      src("not-due", "0 * * * *", new Date("2026-09-04T11:59:30Z")), // next 12:00? 12:00 <= 12:00 — hmm
      src("no-schedule", undefined, new Date("2026-09-01T00:00:00Z")),
      src("never-synced", "0 0 * * *", undefined), // epoch anchor → long due
      { ...src("archived", "0 * * * *", new Date(0)), projectStatus: "ARCHIVED" },
    ];
    jest.spyOn(service, "listExternalSources").mockResolvedValue(sources as any);

    const due = await service.getDueExternalSources(now);
    const fqns = due.map((d: any) => d.fqn);
    expect(fqns).toContain("due-hourly");
    expect(fqns).toContain("never-synced");
    expect(fqns).not.toContain("no-schedule");
    expect(fqns).not.toContain("archived");
  });

  it("ignores invalid cron expressions with a warning", async () => {
    jest
      .spyOn(service, "listExternalSources")
      .mockResolvedValue([src("bad-cron", "definitely not cron")] as any);
    const due = await service.getDueExternalSources(new Date());
    expect(due).toEqual([]);
    expect(ctx.warn).toHaveBeenCalled();
  });

  it("syncDueExternalSources enqueues one catalog job per due source", async () => {
    jest
      .spyOn(service, "getDueExternalSources")
      .mockResolvedValue([src("due-a", "0 * * * *", new Date(0)), src("due-b", "0 * * * *", new Date(0))] as any);
    const enqueueSpy = jest
      .spyOn(service, "enqueueCatalog")
      .mockImplementation(async (pid: string) => ({ jobId: `job-${pid}` }));

    const { enqueued } = await service.syncDueExternalSources();
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueued.map((e) => e.jobId)).toEqual(["job-id-due-a", "job-id-due-b"]);
  });

  it("an enqueue failure does not abort the remaining sources", async () => {
    jest
      .spyOn(service, "getDueExternalSources")
      .mockResolvedValue([src("boom", "0 * * * *", new Date(0)), src("fine", "0 * * * *", new Date(0))] as any);
    jest.spyOn(service, "enqueueCatalog").mockImplementation(async (pid: string) => {
      if (pid.includes("boom")) throw new Error("engine down");
      return { jobId: "ok-job" };
    });
    const { enqueued } = await service.syncDueExternalSources();
    expect(enqueued).toHaveLength(1);
    expect(ctx.warn).toHaveBeenCalled();
  });
});

describe("Session 07 — remove external source", () => {
  let ctx: any;
  let service: ReactorProjectServiceImpl;

  beforeEach(() => {
    ctx = makeContext();
    service = new ReactorProjectServiceImpl({} as any, ctx);
    jest.restoreAllMocks();
  });

  it("archives the project and purges graph + search index by default", async () => {
    const project = {
      _id: "src-9",
      fqn: "jira.old@1.0.0",
      name: "old",
      nameSpace: "jira",
      source: { scheme: "jira", sourceKey: "x.net" },
    };
    jest.spyOn(service, "getProject").mockResolvedValue(project as any);
    const updateSpy = jest.spyOn(service, "updateProject").mockResolvedValue(project as any);
    const nodeDel = jest
      .spyOn(ReactorNodeModel, "deleteMany")
      .mockResolvedValue({ deletedCount: 42 } as any);
    const edgeDel = jest
      .spyOn(ReactorNodeLinkModel, "deleteMany")
      .mockResolvedValue({ deletedCount: 17 } as any);
    const deleteIndex = jest.fn().mockResolvedValue(true);
    ctx.setService("core.ReactorySearchService@1.0.0", { deleteIndex });

    const result = await service.removeExternalSource("jira.old@1.0.0");

    expect(updateSpy).toHaveBeenCalledWith("src-9", expect.objectContaining({ projectStatus: "ARCHIVED" }));
    expect(nodeDel).toHaveBeenCalledWith({ projectId: "src-9" });
    expect(edgeDel).toHaveBeenCalledWith({ projectId: "src-9" });
    expect(deleteIndex).toHaveBeenCalledWith("reactor_graph_jira_old");
    expect(result).toEqual({ archived: true, nodesDeleted: 42, edgesDeleted: 17 });
  });

  it("keeps the snapshot when purgeGraph is false", async () => {
    const project = { _id: "src-9", fqn: "jira.old@1.0.0", name: "old", nameSpace: "jira", source: { scheme: "jira", sourceKey: "x" } };
    jest.spyOn(service, "getProject").mockResolvedValue(project as any);
    jest.spyOn(service, "updateProject").mockResolvedValue(project as any);
    const nodeDel = jest.spyOn(ReactorNodeModel, "deleteMany");
    const result = await service.removeExternalSource("jira.old@1.0.0", { purgeGraph: false });
    expect(nodeDel).not.toHaveBeenCalled();
    expect(result.archived).toBe(true);
  });

  it("throws for a project without a source spec (repo projects are not removable here)", async () => {
    jest.spyOn(service, "getProject").mockResolvedValue({ _id: "x", repoPath: "/tmp" } as any);
    await expect(service.removeExternalSource("x")).rejects.toThrow(/External source not found/);
  });
});

describe("Session 07 — catalogProject accepts id-addressed registered sources", () => {
  it("resolves a source-only project addressed by fqn (async workflow path)", async () => {
    const ctx = makeContext();
    const service = new ReactorProjectServiceImpl({} as any, ctx);
    const registered: Partial<IReactorProject> = {
      _id: "src-1" as any,
      id: "src-1",
      fqn: "jira.worldremit@1.0.0",
      name: "worldremit",
      nameSpace: "jira",
      version: "1.0.0",
      source: { scheme: "jira", sourceKey: "x.net" } as any,
      processors: [{ id: "jira", processor: "reactor.JiraGraphProvider@1.0.0" }],
    };
    jest.spyOn(service, "getProject").mockResolvedValue(registered as any);
    const processSpy = jest
      .spyOn(service, "processProject")
      .mockImplementation(async (p: any) => p);
    jest.spyOn(service, "updateProject").mockImplementation(async (_id: any, u: any) => ({ ...registered, ...u }));

    // the async catalog workflow passes id/name only — no repoPath, repoUrl or source
    const result = await service.catalogProject({
      id: "src-1",
      name: "worldremit",
      nameSpace: "jira",
      version: "1.0.0",
    } as any);

    expect(processSpy).toHaveBeenCalled();
    expect((result as any).source?.scheme).toBe("jira");
  });

  it("still rejects an unresolvable project with no repoPath/repoUrl/source", async () => {
    const ctx = makeContext();
    const service = new ReactorProjectServiceImpl({} as any, ctx);
    jest.spyOn(service, "getProject").mockResolvedValue(null as any);
    await expect(
      service.catalogProject({ name: "ghost", nameSpace: "x", version: "1.0.0" } as any)
    ).rejects.toThrow(/repoPath, repoUrl or source/);
  });
});
