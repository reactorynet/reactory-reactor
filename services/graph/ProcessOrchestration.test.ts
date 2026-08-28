import { randomUUID } from "crypto";
import { runProcessorsForProject } from "./runProcessorsForProject";
import ReactorProjectServiceImpl from "../ReactorProjectService";
import SystemGraphManager from "../SystemGraphManager";
import { IReactorProject, IProjectProcessor } from "../../types/service.types";

const makeContext = (overrides: Record<string, any> = {}) => {
  const store = new Map<string, any>();
  const services = new Map<string, any>();

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
    utils: {
      hash: (val: any) => 12345,
    },
    __store: store,
    ...overrides,
  };
  return ctx;
};

describe("Session 15 — Process Orchestration Hardening", () => {
  it("runProcessorsForProject passes shared runId and skips GC for all except the last processor", async () => {
    const calls: any[] = [];
    const mockProc1: IProjectProcessor = {
      nameSpace: "reactor",
      name: "Proc1",
      version: "1.0.0",
      process: jest.fn().mockImplementation(async (project, options) => {
        calls.push({ processor: "proc1", options });
        return { ...project, proc1Ran: true };
      }),
      supportsProject: () => true,
      getProjectData: async (p) => p,
      getProjectTypes: () => [],
      getProjectNode: async () => ({} as any),
      getChildrenForNode: async () => [],
      getAttributes: async () => [],
      getFileSpecs: () => [],
      setFileSpecs: async (p) => p,
      sync: async (p: any) => p,
      index: async (p: any) => p,
    } as any;

    const mockProc2: IProjectProcessor = {
      nameSpace: "reactor",
      name: "Proc2",
      version: "1.0.0",
      process: jest.fn().mockImplementation(async (project, options) => {
        calls.push({ processor: "proc2", options });
        return { ...project, proc2Ran: true };
      }),
      supportsProject: () => true,
      getProjectData: async (p) => p,
      getProjectTypes: () => [],
      getProjectNode: async () => ({} as any),
      getChildrenForNode: async () => [],
      getAttributes: async () => [],
      getFileSpecs: () => [],
      setFileSpecs: async (p) => p,
      sync: async (p: any) => p,
      index: async (p: any) => p,
    } as any;

    const project: Partial<IReactorProject> = {
      id: "proj-orch-1",
      name: "orch-test",
      nameSpace: "test",
      version: "1.0.0",
      processors: [
        { id: "proc1", processor: "reactor.Proc1@1.0.0" },
        { id: "proc2", processor: "reactor.Proc2@1.0.0" },
      ],
    };

    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    const onAfterAll = jest.fn().mockResolvedValue(undefined);

    const result = await runProcessorsForProject({
      project,
      getProcessor: (fqn) => {
        if (fqn === "reactor.Proc1@1.0.0" || fqn === "proc1") return mockProc1;
        if (fqn === "reactor.Proc2@1.0.0" || fqn === "proc2") return mockProc2;
        return null;
      },
      onAfterAll,
      log,
    });

    expect(calls).toHaveLength(2);
    // Same shared runId passed to both processors
    expect(calls[0].options.runId).toBeDefined();
    expect(calls[0].options.runId).toBe(calls[1].options.runId);
    expect(calls[0].options.runId).toBe(result.runId);

    // GC skipped for first, not skipped for second (last)
    expect(calls[0].options.skipGc).toBe(true);
    expect(calls[1].options.skipGc).toBe(false);

    // Result merged project fields
    expect(result.project.proc1Ran).toBe(true);
    expect(result.project.proc2Ran).toBe(true);

    // Post hook called once with canonical projectId
    expect(onAfterAll).toHaveBeenCalledWith("proj-orch-1");
  });

  it("ReactorProjectService.processProject uses shared runId and single GC across multi processors", async () => {
    const ctx = makeContext();
    const service = new ReactorProjectServiceImpl({}, ctx);

    const calls: any[] = [];
    const mockProc1: any = {
      name: "NodeJS",
      nameSpace: "reactor",
      version: "1.0.0",
      supportsProject: () => true,
      process: jest.fn().mockImplementation(async (project, options) => {
        calls.push({ name: "nodejs", options });
        return { ...project, nodejsDone: true };
      }),
    };

    const mockProc2: any = {
      name: "Markdown",
      nameSpace: "reactor",
      version: "1.0.0",
      supportsProject: () => true,
      process: jest.fn().mockImplementation(async (project, options) => {
        calls.push({ name: "markdown", options });
        return { ...project, markdownDone: true };
      }),
    };

    (service as any).processors["nodejs"] = mockProc1;
    (service as any).processors["markdown"] = mockProc2;

    const project: Partial<IReactorProject> = {
      _id: "66cd12345678901234567890" as any,
      name: "hybrid-proj",
      nameSpace: "test",
      version: "1.0.0",
      repoPath: "/tmp/fake-repo",
      processors: [
        { id: "nodejs", processor: "reactor.NodeJSProjectProcessor@1.0.0" },
        { id: "markdown", processor: "reactor.MarkdownProjectProcessor@1.0.0" },
      ],
    };

    const res = await service.processProject(project);

    expect(calls).toHaveLength(2);
    expect(calls[0].options.runId).toBeDefined();
    expect(calls[0].options.runId).toBe(calls[1].options.runId);
    expect(calls[0].options.skipGc).toBe(true);
    expect(calls[1].options.skipGc).toBe(false);

    expect(res.nodejsDone).toBe(true);
    expect(res.markdownDone).toBe(true);
    expect(res.id).toBe("66cd12345678901234567890");
  });

  it("SystemGraphManager.catalogProject delegates to shared runProcessorsForProject", async () => {
    const ctx = makeContext();
    const manager = new SystemGraphManager({}, ctx);

    const calls: any[] = [];
    const mockProc: any = {
      name: "NodeJS",
      nameSpace: "reactor",
      version: "1.0.0",
      supportsProject: () => true,
      process: jest.fn().mockImplementation(async (_project, options) => {
        calls.push(options);
        return [{ id: "search-1", name: "Search 1" }];
      }),
    };

    ctx.setService("reactor.NodeJSProjectProcessor@1.0.0", mockProc);

    const project: Partial<IReactorProject> = {
      id: "proj-mgr-1",
      name: "mgr-proj",
      nameSpace: "test",
      version: "1.0.0",
      repoPath: "/tmp/fake-repo",
      processors: [
        { id: "nodejs", processor: "reactor.NodeJSProjectProcessor@1.0.0" },
      ],
    };

    const results = await manager.catalogProject(project);

    expect(calls).toHaveLength(1);
    expect(calls[0].runId).toBeDefined();
    expect(calls[0].skipGc).toBe(false);
    expect(results).toHaveLength(1);
  });
});
