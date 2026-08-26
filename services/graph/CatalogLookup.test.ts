import SystemGraphManager from "../SystemGraphManager";
import ReactorProjectServiceImpl from "../ReactorProjectService";
import { ReactorProjectModel } from "../../models/ReactorProject";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import {
  nodeId,
  projectLogicalKey,
  projectFqn,
} from "./GraphIdentity";
import { ReactorNodeType } from "../../types/model.types";
import { IReactorProject } from "../../types/service.types";

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
      hash: (val: any) => nodeId(String(val)),
    },
    __store: store,
    ...overrides,
  };
  return ctx;
};

describe("Session 04 — O(1) Catalog Node & Project Lookup", () => {
  const testProject: Partial<IReactorProject> = {
    id: "proj-123",
    name: "catalog-service",
    nameSpace: "reactor",
    version: "1.0.0",
    repoPath: "/path/to/catalog-service",
    description: "Catalog service test fixture",
    projectTypes: ["typescript"],
    processors: [
      {
        id: "nodejs",
        processor: "reactor.NodeJSProjectProcessor@1.0.0",
      },
    ],
  };

  const expectedRootId = nodeId(projectLogicalKey(testProject));

  describe("SystemGraphManager O(1) Lookups", () => {
    let ctx: any;
    let manager: SystemGraphManager;
    let mockProjectService: any;

    beforeEach(() => {
      ctx = makeContext();
      manager = new SystemGraphManager({}, ctx);

      mockProjectService = {
        getProjects: jest.fn(),
        getProject: jest.fn(),
        getProjectByGraphRootId: jest.fn(),
      };
      manager.setProjectService(mockProjectService);
    });

    it("getCatalogNode(id) resolves project by graphRootId without calling getProjects (O(1))", async () => {
      // Mock ReactorNodeModel.findOne to return null (no persisted root)
      jest.spyOn(ReactorNodeModel, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      } as any);

      mockProjectService.getProjectByGraphRootId.mockResolvedValue(testProject);

      const node = await manager.getCatalogNode(expectedRootId);

      expect(mockProjectService.getProjectByGraphRootId).toHaveBeenCalledWith(expectedRootId);
      expect(mockProjectService.getProjects).not.toHaveBeenCalled();
      expect(node.id).toBe(expectedRootId);
      expect(node.name).toBe("catalog-service");
    });

    it("getCatalogNode(id) returns persisted SYSTEM/DATASTORE root when parentId is null", async () => {
      const persistedRoot = {
        id: 9999,
        index: 9999,
        key: "9999",
        name: "Persisted System Root",
        nameSpace: "reactor",
        version: "1.0.0",
        type: ReactorNodeType.SYSTEM,
        parentId: null,
      };

      jest.spyOn(ReactorNodeModel, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue(persistedRoot),
      } as any);

      const node = await manager.getCatalogNode(9999);

      expect(node).toEqual(persistedRoot);
      expect(mockProjectService.getProjectByGraphRootId).not.toHaveBeenCalled();
      expect(mockProjectService.getProjects).not.toHaveBeenCalled();
    });

    it("getCatalogNode(id) throws 404 when project is not found", async () => {
      jest.spyOn(ReactorNodeModel, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      } as any);

      mockProjectService.getProjectByGraphRootId.mockResolvedValue(null);

      await expect(manager.getCatalogNode(12345)).rejects.toThrow("Node 12345 not found");
      expect(mockProjectService.getProjects).not.toHaveBeenCalled();
    });

    it("getProjectForCatalogNode(node) uses getProjectByGraphRootId without calling getProjects (O(1))", async () => {
      mockProjectService.getProjectByGraphRootId.mockResolvedValue(testProject);

      const project = await manager.getProjectForCatalogNode({ id: expectedRootId });

      expect(mockProjectService.getProjectByGraphRootId).toHaveBeenCalledWith(expectedRootId);
      expect(mockProjectService.getProjects).not.toHaveBeenCalled();
      expect(project).toEqual(testProject);
    });

    it("getCatalogNodes(paging) supports paging with default pageSize 100", async () => {
      mockProjectService.getProjects.mockResolvedValue({
        projects: [testProject],
        paging: { total: 1, page: 1, pageSize: 100, hasNext: false },
      });

      const nodes = await manager.getCatalogNodes();

      expect(mockProjectService.getProjects).toHaveBeenCalledWith({
        paging: { page: 1, pageSize: 100 },
        filter: {},
        search: "",
      });
      expect(nodes.length).toBe(1);
      expect(nodes[0].id).toBe(expectedRootId);
    });
  });

  describe("ReactorProjectService graphRootId & Lazy Backfill", () => {
    let ctx: any;
    let projectService: ReactorProjectServiceImpl;

    beforeEach(() => {
      ctx = makeContext();
      projectService = new ReactorProjectServiceImpl({}, ctx);
      jest.restoreAllMocks();
    });

    it("createProject computes and stamps graphRootId if missing", async () => {
      const createSpy = jest.spyOn(ReactorProjectModel, "create").mockImplementation(async (doc: any) => {
        return {
          ...doc,
          _id: "mongo-id-1",
          toObject: () => ({ ...doc, _id: "mongo-id-1" }),
        } as any;
      });

      const created = await projectService.createProject({
        name: "new-service",
        nameSpace: "reactor",
        version: "1.0.0",
      });

      const expectedId = nodeId("reactor.new-service@1.0.0");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          graphRootId: expectedId,
        })
      );
      expect(created.graphRootId).toBe(expectedId);
    });

    it("getProjectByGraphRootId queries by graphRootId in Mongo", async () => {
      const mockFindOne = jest.spyOn(ReactorProjectModel, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "mongo-id-2",
          name: "catalog-service",
          nameSpace: "reactor",
          version: "1.0.0",
          graphRootId: expectedRootId,
        }),
      } as any);

      const found = await projectService.getProjectByGraphRootId(expectedRootId);

      expect(mockFindOne).toHaveBeenCalledWith(
        { graphRootId: expectedRootId },
        expect.any(Object),
        expect.any(Object)
      );
      expect(found).toBeDefined();
      expect(found.graphRootId).toBe(expectedRootId);
    });

    it("getProjectByGraphRootId performs lazy backfill when project lacks graphRootId", async () => {
      // 1. First findOne by graphRootId returns null
      jest.spyOn(ReactorProjectModel, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      } as any);

      // 2. find unindexed projects finds legacy project
      const legacyDoc = {
        _id: "mongo-id-legacy",
        name: "catalog-service",
        nameSpace: "reactor",
        version: "1.0.0",
      };

      jest.spyOn(ReactorProjectModel, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([legacyDoc]),
      } as any);

      const updateOneSpy = jest.spyOn(ReactorProjectModel, "updateOne").mockResolvedValue({} as any);

      const found = await projectService.getProjectByGraphRootId(expectedRootId);

      expect(updateOneSpy).toHaveBeenCalledWith(
        { _id: "mongo-id-legacy" },
        { $set: { graphRootId: expectedRootId } }
      );
      expect(found).toBeDefined();
      expect(found.id).toBe("mongo-id-legacy");
      expect(found.graphRootId).toBe(expectedRootId);
    });

    it("getProjectForCatalogNode delegates to getProjectByGraphRootId", async () => {
      const getByRootSpy = jest
        .spyOn(projectService, "getProjectByGraphRootId")
        .mockResolvedValue(testProject);

      const project = await projectService.getProjectForCatalogNode({ id: expectedRootId });

      expect(getByRootSpy).toHaveBeenCalledWith(expectedRootId);
      expect(project).toEqual(testProject);
    });
  });
});
