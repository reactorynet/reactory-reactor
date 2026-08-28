import SystemGraphManager from "../SystemGraphManager";
import ReactorSystemGraph from "../../graphql/resolvers/ReactorSystemGraph";
import { ReactorNodeType, ReactorNodeLink } from "../../types/model.types";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";

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
    __store: store,
    ...overrides,
  };
  return ctx;
};

describe("Session 06 — GraphQL Façade Consistency & Paging Fixes", () => {
  describe("SystemGraphManager helper methods", () => {
    let ctx: any;
    let manager: SystemGraphManager;

    beforeEach(() => {
      ctx = makeContext();
      manager = new SystemGraphManager({}, ctx);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe("findNodesByType", () => {
      it("returns [] for empty type list", async () => {
        expect(await manager.findNodesByType([])).toEqual([]);
      });

      it("queries persisted nodes and returns results when found", async () => {
        const persisted = [{ id: 1, name: "node1", type: ReactorNodeType.FILE }];
        jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(persisted),
          }),
        } as any);

        const results = await manager.findNodesByType([ReactorNodeType.FILE], 10);
        expect(results).toEqual(persisted);
        expect(ReactorNodeModel.find).toHaveBeenCalledWith({ type: { $in: [ReactorNodeType.FILE] } });
      });

      it("falls back to getCatalogNodes when no persisted nodes match", async () => {
        jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
          }),
        } as any);

        const catalogNodes = [
          { id: 1, name: "sys", type: ReactorNodeType.SYSTEM },
          { id: 2, name: "file", type: ReactorNodeType.FILE },
        ];
        jest.spyOn(manager, "getCatalogNodes").mockResolvedValue(catalogNodes as any);

        const results = await manager.findNodesByType([ReactorNodeType.SYSTEM], 10);
        expect(results).toEqual([catalogNodes[0]]);
      });
    });

    describe("findNodesByCategory", () => {
      it("returns [] for empty category id list", async () => {
        expect(await manager.findNodesByCategory([])).toEqual([]);
      });

      it("queries persisted nodes by category ID and returns results", async () => {
        const persisted = [{ id: 1, name: "catNode", categories: [{ id: 10, title: "Cat" }] }];
        jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(persisted),
          }),
        } as any);

        const results = await manager.findNodesByCategory([10], 10);
        expect(results).toEqual(persisted);
        expect(ReactorNodeModel.find).toHaveBeenCalledWith({ "categories.id": { $in: [10] } });
      });
    });

    describe("findLinks", () => {
      it("handles pagination with 1-based page and skip calculation", async () => {
        const sampleLinks = [{ id: 101, source: 1, target: 2 }];
        const skipMock = jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(sampleLinks),
          }),
        });

        jest.spyOn(ReactorNodeLinkModel, "find").mockReturnValue({
          skip: skipMock,
        } as any);
        jest.spyOn(ReactorNodeLinkModel, "countDocuments").mockResolvedValue(15 as any);

        // Page 1: skip = 0
        const resPage1 = await manager.findLinks({
          sources: [1],
          paging: { page: 1, pageSize: 10 },
        });

        expect(skipMock).toHaveBeenCalledWith(0);
        expect(resPage1.links).toEqual(sampleLinks);
        expect(resPage1.paging).toEqual({
          total: 15,
          page: 1,
          pageSize: 10,
          hasNext: true,
        });

        // Page 2: skip = 10 (returns remaining 5 items)
        const page2Links = [
          { id: 102, source: 1, target: 3 },
          { id: 103, source: 1, target: 4 },
          { id: 104, source: 1, target: 5 },
          { id: 105, source: 1, target: 6 },
          { id: 106, source: 1, target: 7 },
        ];
        skipMock.mockReturnValueOnce({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(page2Links),
          }),
        });

        const resPage2 = await manager.findLinks({
          sources: [1],
          paging: { page: 2, pageSize: 10 },
        });

        expect(skipMock).toHaveBeenCalledWith(10);
        expect(resPage2.paging).toEqual({
          total: 15,
          page: 2,
          pageSize: 10,
          hasNext: false,
        });
      });
    });

    describe("updateNode", () => {
      it("persists node update and busts cache", async () => {
        const updatedDoc = { id: 42, name: "updated", data: { foo: "bar" } };
        jest.spyOn(ReactorNodeModel, "findOneAndUpdate").mockReturnValue({
          lean: jest.fn().mockResolvedValue(updatedDoc),
        } as any);

        await ctx.setValue("REACTOR_NODE_42", { id: 42, name: "old" });

        const result = await manager.updateNode(42, { data: { foo: "bar" } });
        expect(result).toEqual(updatedDoc);
        expect(ReactorNodeModel.findOneAndUpdate).toHaveBeenCalledWith(
          { id: 42 },
          expect.objectContaining({ $set: expect.objectContaining({ data: { foo: "bar" } }) }),
          { new: true }
        );

        // Cache was cleared
        expect(await ctx.getValue("REACTOR_NODE_42")).toBeNull();
      });

      it("throws 404 when node is not found", async () => {
        jest.spyOn(ReactorNodeModel, "findOneAndUpdate").mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        } as any);

        await expect(manager.updateNode(999, { data: {} })).rejects.toThrow("Node not found with ID 999");
      });
    });
  });

  describe("GraphQL Resolvers Façade Delegation", () => {
    let ctx: any;
    let resolver: ReactorSystemGraph;
    let mockGraphSvc: any;

    beforeEach(() => {
      ctx = makeContext();
      resolver = new ReactorSystemGraph();

      mockGraphSvc = {
        searchNodes: jest.fn().mockResolvedValue([]),
        getNode: jest.fn().mockResolvedValue({ id: 1 }),
        getCatalogNodes: jest.fn().mockResolvedValue([]),
        getCategoryNodes: jest.fn().mockResolvedValue([{ id: 1, title: "Category 1" }]),
        findNodesByType: jest.fn().mockResolvedValue([]),
        findNodesByCategory: jest.fn().mockResolvedValue([]),
        findLinks: jest.fn().mockResolvedValue({ links: [], paging: { total: 0, page: 1, pageSize: 25, hasNext: false } }),
        updateNode: jest.fn().mockResolvedValue({ id: 10, data: { updated: true } }),
        linkExternalProjects: jest.fn().mockResolvedValue({ createdLinks: 3, totalExternals: 5 }),
      };

      ctx.setService("reactor.SystemGraphManager@1.0.0", mockGraphSvc);
    });

    it("ReactorCatalogNodes normalizes paging and delegates to getCatalogNodes", async () => {
      mockGraphSvc.getCatalogNodes.mockResolvedValue([{ id: 10 }, { id: 20 }]);

      const res = await resolver.ReactorCatalogNodes(null, { paging: { page: 2, pageSize: 50 } }, ctx);

      expect(mockGraphSvc.getCatalogNodes).toHaveBeenCalledWith({ page: 2, pageSize: 50 });
      expect(res.paging).toEqual({
        total: 2,
        page: 2,
        pageSize: 50,
        hasNext: false,
      });
    });

    it("ReactorNodesForType delegates to manager.findNodesByType", async () => {
      mockGraphSvc.findNodesByType.mockResolvedValue([{ id: 1, type: ReactorNodeType.FILE }]);

      const res = await resolver.ReactorNodesForType(null, { type: [ReactorNodeType.FILE] }, ctx);

      // Resolver caps/passes an explicit limit (legacy default 1000) to the manager façade.
      expect(mockGraphSvc.findNodesByType).toHaveBeenCalledWith([ReactorNodeType.FILE], 1000);
      expect(res).toEqual([{ id: 1, type: ReactorNodeType.FILE }]);
    });

    it("ReactorNodesByTerm delegates to manager.searchNodes with capped limit", async () => {
      mockGraphSvc.searchNodes.mockResolvedValue([{ id: 2, name: "foundNode" }]);

      const res = await resolver.ReactorNodesByTerm(null, { term: "auth" }, ctx);

      expect(mockGraphSvc.searchNodes).toHaveBeenCalledWith("auth", { limit: 100 });
      expect(res).toEqual([{ id: 2, name: "foundNode" }]);
    });

    it("ReactorNodeByCategory delegates to manager.findNodesByCategory", async () => {
      mockGraphSvc.findNodesByCategory.mockResolvedValue([{ id: 3 }]);

      const res = await resolver.ReactorNodeByCategory(null, { ids: [1, 2] }, ctx);

      expect(mockGraphSvc.findNodesByCategory).toHaveBeenCalledWith([1, 2]);
      expect(res).toEqual([{ id: 3 }]);
    });

    it("ReactorNodeLinks delegates to manager.findLinks", async () => {
      const mockResult = {
        links: [{ id: 101, source: 1, target: 2 } as ReactorNodeLink],
        paging: { total: 1, page: 1, pageSize: 25, hasNext: false },
      };
      mockGraphSvc.findLinks.mockResolvedValue(mockResult);

      const args = { sources: [1], targets: [2], paging: { page: 1, pageSize: 25 } };
      const res = await resolver.ReactorNodeLinks(null, args, ctx);

      expect(mockGraphSvc.findLinks).toHaveBeenCalledWith(args);
      expect(res).toEqual(mockResult);
    });

    it("ReactorUpdateNode delegates to manager.updateNode", async () => {
      const updatedNode = { id: 50, data: { name: "custom" } };
      mockGraphSvc.updateNode.mockResolvedValue(updatedNode);

      const res = await resolver.ReactorUpdateNode(null, { id: 50, data: { name: "custom" } }, ctx);

      expect(mockGraphSvc.updateNode).toHaveBeenCalledWith(50, { data: { name: "custom" } });
      expect(res).toEqual(updatedNode);
    });

    it("ReactorLinkCrossProjectDeps delegates to manager.linkExternalProjects", async () => {
      const res = await resolver.ReactorLinkCrossProjectDeps(null, { projectId: "proj-1" }, ctx);

      expect(mockGraphSvc.linkExternalProjects).toHaveBeenCalledWith("proj-1");
      expect(res).toEqual({
        createdLinks: 3,
        totalExternals: 5,
        message: "Created 3 cross-project link(s) across 5 external dependency node(s)",
      });
    });
  });
});
