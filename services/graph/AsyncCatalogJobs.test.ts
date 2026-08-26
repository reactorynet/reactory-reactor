import SystemGraphManager from "../SystemGraphManager";
import ReactorProjectServiceImpl from "../ReactorProjectService";
import ReactorSystemGraph from "../../graphql/resolvers/ReactorSystemGraph";
import { ReactorProjectModel } from "../../models/ReactorProject";

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
      hash: (val: any) => String(val).length,
    },
    user: { id: "test-user-1", email: "tester@example.com" },
    partner: { key: "test-partner" },
    __store: store,
    ...overrides,
  };
  return ctx;
};

describe("Session 09 — Async Catalog & Index Jobs", () => {
  let ctx: any;
  let projectSvc: ReactorProjectServiceImpl;
  let graphManager: SystemGraphManager;
  let mockWorkflowService: any;
  let mockRunner: any;

  beforeEach(() => {
    ctx = makeContext();

    mockRunner = {
      isInitialized: jest.fn().mockReturnValue(true),
      startWorkflow: jest.fn().mockResolvedValue("exec-job-123"),
      getWorkflowInstance: jest.fn(),
      getLifecycleManager: jest.fn().mockReturnValue({
        getWorkflowInstance: jest.fn(),
      }),
    };

    mockWorkflowService = {
      workflowRunner: mockRunner,
      onStartup: jest.fn().mockResolvedValue(undefined),
      getWorkflowInstance: jest.fn(),
    };

    ctx.setService("core.ReactoryWorkflowService@1.0.0", mockWorkflowService);

    projectSvc = new ReactorProjectServiceImpl({}, ctx);
    graphManager = new SystemGraphManager({}, ctx);
    graphManager.setProjectService(projectSvc);

    ctx.setService("reactor.ReactorProjectService@1.0.0", projectSvc);
    ctx.setService("reactor.SystemGraphManager@1.0.0", graphManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("ReactorProjectService.enqueueCatalog & Idempotency", () => {
    it("enqueues a CatalogProjectGraph workflow and returns a jobId", async () => {
      const mockProject = {
        _id: "60c72b2f9b1d8b2bad000001",
        id: "60c72b2f9b1d8b2bad000001",
        name: "my-app",
        nameSpace: "reactory",
        version: "1.0.0",
        repoPath: "/path/to/my-app",
      };

      jest.spyOn(projectSvc, "getProject").mockResolvedValue(mockProject as any);
      jest.spyOn(projectSvc, "updateProject").mockResolvedValue(mockProject as any);

      const result = await projectSvc.enqueueCatalog("60c72b2f9b1d8b2bad000001");

      expect(result).toEqual({
        jobId: "exec-job-123",
        message: "Catalog job accepted",
      });

      expect(mockRunner.startWorkflow).toHaveBeenCalledWith(
        "reactor.CatalogProjectGraph@1.0.0",
        "1.0.0",
        expect.objectContaining({
          projectId: "60c72b2f9b1d8b2bad000001",
          name: "my-app",
          nameSpace: "reactory",
          version: "1.0.0",
          repoPath: "/path/to/my-app",
          forceFull: false,
        }),
        ctx
      );

      expect(projectSvc.updateProject).toHaveBeenCalledWith(
        "60c72b2f9b1d8b2bad000001",
        expect.objectContaining({ indexingJobId: "exec-job-123" })
      );
    });

    it("returns existing jobId if an active job is already RUNNING for the project", async () => {
      const mockProject = {
        _id: "60c72b2f9b1d8b2bad000001",
        id: "60c72b2f9b1d8b2bad000001",
        name: "my-app",
        nameSpace: "reactory",
        indexingJobId: "active-job-456",
      };

      jest.spyOn(projectSvc, "getProject").mockResolvedValue(mockProject as any);
      mockRunner.getWorkflowInstance.mockReturnValue({
        id: "active-job-456",
        status: 1, // RUNNABLE / RUNNING
      });

      const result = await projectSvc.enqueueCatalog("60c72b2f9b1d8b2bad000001", { forceFull: false });

      expect(result).toEqual({
        jobId: "active-job-456",
        message: "Catalog job already running for project",
      });
      expect(mockRunner.startWorkflow).not.toHaveBeenCalled();
    });

    it("re-enqueues if forceFull is true even if a job is in progress", async () => {
      const mockProject = {
        _id: "60c72b2f9b1d8b2bad000001",
        id: "60c72b2f9b1d8b2bad000001",
        name: "my-app",
        nameSpace: "reactory",
        indexingJobId: "active-job-456",
      };

      jest.spyOn(projectSvc, "getProject").mockResolvedValue(mockProject as any);
      jest.spyOn(projectSvc, "updateProject").mockResolvedValue(mockProject as any);

      const result = await projectSvc.enqueueCatalog("60c72b2f9b1d8b2bad000001", { forceFull: true });

      expect(result.jobId).toBe("exec-job-123");
      expect(mockRunner.startWorkflow).toHaveBeenCalled();
    });

    it("throws when project is not found", async () => {
      jest.spyOn(projectSvc, "getProject").mockResolvedValue(null);

      await expect(projectSvc.enqueueCatalog("nonexistent")).rejects.toThrow(
        "Project not found: nonexistent"
      );
    });
  });

  describe("getCatalogJobStatus", () => {
    it("returns RUNNING for status code 1", async () => {
      const startTime = new Date("2026-08-26T10:00:00Z");
      mockRunner.getWorkflowInstance.mockReturnValue({
        id: "job-1",
        status: 1,
        startedAt: startTime,
      });

      const status = await projectSvc.getCatalogJobStatus("job-1");
      expect(status).toEqual({
        jobId: "job-1",
        status: "RUNNING",
        message: "Job is running",
        error: undefined,
        startedAt: startTime,
        completedAt: undefined,
      });
    });

    it("returns PENDING for status code 0 or 4 (SUSPENDED)", async () => {
      mockRunner.getWorkflowInstance.mockReturnValue({
        id: "job-2",
        status: 0,
      });

      const status = await projectSvc.getCatalogJobStatus("job-2");
      expect(status.status).toBe("PENDING");
    });

    it("returns COMPLETE for status code 2", async () => {
      const endTime = new Date("2026-08-26T10:05:00Z");
      mockRunner.getWorkflowInstance.mockReturnValue({
        id: "job-3",
        status: 2,
        completedAt: endTime,
      });

      const status = await projectSvc.getCatalogJobStatus("job-3");
      expect(status.status).toBe("COMPLETE");
      expect(status.completedAt).toEqual(endTime);
    });

    it("returns FAILED with error message for status code 3", async () => {
      mockRunner.getWorkflowInstance.mockReturnValue({
        id: "job-4",
        status: 3,
        error: new Error("Analysis timeout"),
      });

      const status = await projectSvc.getCatalogJobStatus("job-4");
      expect(status.status).toBe("FAILED");
      expect(status.error).toBe("Analysis timeout");
    });

    it("returns completed fallback when instance is no longer in active memory", async () => {
      mockRunner.getWorkflowInstance.mockReturnValue(null);

      const status = await projectSvc.getCatalogJobStatus("job-expired");
      expect(status.status).toBe("COMPLETE");
      expect(status.message).toContain("not in active memory");
    });
  });

  describe("SystemGraphManager delegation", () => {
    it("enqueueCatalog delegates to projectService", async () => {
      jest.spyOn(projectSvc, "enqueueCatalog").mockResolvedValue({
        jobId: "delegated-job-1",
        message: "Accepted",
      });

      const res = await graphManager.enqueueCatalog("proj-1", { forceFull: true });
      expect(res).toEqual({ jobId: "delegated-job-1", message: "Accepted" });
      expect(projectSvc.enqueueCatalog).toHaveBeenCalledWith("proj-1", { forceFull: true });
    });

    it("getCatalogJobStatus delegates to projectService", async () => {
      jest.spyOn(projectSvc, "getCatalogJobStatus").mockResolvedValue({
        jobId: "job-abc",
        status: "RUNNING",
      });

      const res = await graphManager.getCatalogJobStatus("job-abc");
      expect(res).toEqual({ jobId: "job-abc", status: "RUNNING" });
      expect(projectSvc.getCatalogJobStatus).toHaveBeenCalledWith("job-abc");
    });
  });

  describe("GraphQL Resolvers: ReactorSyncCatalogNodes & ReactorIndexNodes", () => {
    let resolver: ReactorSystemGraph;

    beforeEach(() => {
      resolver = new ReactorSystemGraph();
    });

    it("ReactorSyncCatalogNodes defaults to async: true and returns ReactorCatalogJobAccepted in < 1s", async () => {
      const mockProject = { _id: "60c72b2f9b1d8b2bad000001", id: "60c72b2f9b1d8b2bad000001", name: "p1" };
      const mockNode = { id: 100, name: "node-p1" };

      jest.spyOn(graphManager, "getProjectForCatalogNode").mockResolvedValue(mockProject as any);
      jest.spyOn(graphManager, "getCatalogNode").mockResolvedValue(mockNode as any);
      jest.spyOn(graphManager, "enqueueCatalog").mockResolvedValue({ jobId: "job-async-1", message: "Catalog job enqueued" });
      jest.spyOn(graphManager, "catalogProject").mockResolvedValue([]);

      const start = Date.now();
      const res = await resolver.syncCatalogNodes(
        null,
        { request: { ids: [100] } }, // async omitted -> defaults true
        ctx
      );
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(graphManager.enqueueCatalog).toHaveBeenCalledWith("60c72b2f9b1d8b2bad000001");
      expect(graphManager.catalogProject).not.toHaveBeenCalled();
      expect(res).toEqual([
        {
          __typename: "ReactorCatalogJobAccepted",
          jobId: "job-async-1",
          message: "Catalog job enqueued",
          node: mockNode,
        },
      ]);
    });

    it("ReactorSyncCatalogNodes with async: false blocks and runs synchronously", async () => {
      const mockProject = { _id: "60c72b2f9b1d8b2bad000001", id: "60c72b2f9b1d8b2bad000001", name: "p1" };
      const mockNode = { id: 100, name: "node-p1" };

      jest.spyOn(graphManager, "getProjectForCatalogNode").mockResolvedValue(mockProject as any);
      jest.spyOn(graphManager, "getCatalogNode").mockResolvedValue(mockNode as any);
      jest.spyOn(graphManager, "catalogProject").mockResolvedValue([]);
      jest.spyOn(graphManager, "enqueueCatalog");

      const res = await resolver.syncCatalogNodes(
        null,
        { request: { ids: [100] }, async: false },
        ctx
      );

      expect(graphManager.catalogProject).toHaveBeenCalledWith(mockProject);
      expect(graphManager.enqueueCatalog).not.toHaveBeenCalled();
      expect(res).toEqual([
        {
          __typename: "CatalogNodeSyncSuccess",
          node: mockNode,
          message: "Catalog node sync complete",
        },
      ]);
    });

    it("ReactorIndexNodes with async: true enqueues jobs and returns catalog nodes immediately", async () => {
      const mockProjects = [
        { _id: "proj-1", id: "proj-1", name: "p1" },
        { _id: "proj-2", id: "proj-2", name: "p2" },
      ];

      jest.spyOn(projectSvc, "getProjects").mockResolvedValue({
        projects: mockProjects,
        paging: { total: 2, page: 1, pageSize: 10, hasNext: false },
      } as any);
      jest.spyOn(projectSvc, "index");
      jest.spyOn(graphManager, "enqueueCatalog").mockResolvedValue({ jobId: "job-x" });
      jest.spyOn(graphManager, "getCatalogNodes").mockResolvedValue([{ id: 1 }, { id: 2 }] as any);

      const res = await resolver.indexNodes(
        null,
        { filter: { search: "p" } as any, async: true },
        ctx
      );

      expect(graphManager.enqueueCatalog).toHaveBeenCalledTimes(2);
      expect(projectSvc.index).not.toHaveBeenCalled();
      expect(res.nodes).toHaveLength(2);
    });

    it("ReactorCatalogJobStatus query delegates to getCatalogJobStatus", async () => {
      jest.spyOn(graphManager, "getCatalogJobStatus").mockResolvedValue({
        jobId: "job-test-99",
        status: "COMPLETE",
        message: "Done",
      });

      const res = await resolver.ReactorCatalogJobStatus(null, { jobId: "job-test-99" }, ctx);

      expect(graphManager.getCatalogJobStatus).toHaveBeenCalledWith("job-test-99");
      expect(res).toEqual({
        jobId: "job-test-99",
        status: "COMPLETE",
        message: "Done",
      });
    });
  });
});
