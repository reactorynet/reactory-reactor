import fs from "fs";
import os from "os";
import path from "path";
import NodeJSProjectProcessor from "../ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor";
import SystemGraphManager from "../SystemGraphManager";
import ReactorSystemGraph from "../../graphql/resolvers/ReactorSystemGraph";
import {
  nodeId,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
} from "./GraphIdentity";
import { writeProject, cleanup } from "./testUtils";
import { ReactorNodeType } from "../../types/model.types";

/** Minimal in-memory Reactory context for testing. */
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

describe("Searchable Node ID Alignment (Session 03)", () => {
  let tempDir: string;
  let testProject: any;

  beforeEach(() => {
    const res = writeProject(
      {
        "package.json": JSON.stringify({ name: "search-fixture", version: "1.0.0" }),
        "README.md": "# Search Fixture Doc\n",
        "src/index.ts": "export const index = 1;\n",
        "src/a/b/nested.ts": "export const nestedValue = 42;\n",
      },
      { name: "search-fixture", nameSpace: "test", version: "1.0.0" }
    );
    tempDir = res.dir;
    testProject = res.project;
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe("BaseProjectProcessor buildSearchable & symlinks", () => {
    class CapturingProcessor extends NodeJSProjectProcessor {
      public capturedNodes: any[] = [];
      public capturedSearchables: any[] = [];

      protected async persistGraph(nodes: any[], edges: any[], meta?: any) {
        this.capturedNodes = nodes;
      }

      protected async indexSearchables(_project: any, searchables: any[]) {
        this.capturedSearchables = searchables;
      }
    }

    it("file searchable carries nodeId equal to graph file node id and id equal to logicalKey", async () => {
      const ctx = makeContext();
      const p = new CapturingProcessor({}, ctx);
      await p.process(testProject, { skipGc: true });

      const fqn = projectFqn(testProject);
      expect(p.capturedSearchables.length).toBeGreaterThan(0);

      // Verify root-level file: package.json
      const pkgSearchable = p.capturedSearchables.find((s) => s.path.endsWith("package.json"));
      expect(pkgSearchable).toBeDefined();
      const pkgLogicalKey = pathLogicalKey(fqn, "package.json");
      const pkgExpectedNodeId = nodeId(pkgLogicalKey);
      expect(pkgSearchable.id).toBe(pkgLogicalKey);
      expect(pkgSearchable.nodeId).toBe(pkgExpectedNodeId);

      // Verify nested path: src/a/b/nested.ts
      const nestedSearchable = p.capturedSearchables.find((s) => s.path.endsWith("src/a/b/nested.ts"));
      expect(nestedSearchable).toBeDefined();
      const nestedLogicalKey = pathLogicalKey(fqn, "src/a/b/nested.ts");
      const nestedExpectedNodeId = nodeId(nestedLogicalKey);
      expect(nestedSearchable.id).toBe(nestedLogicalKey);
      expect(nestedSearchable.nodeId).toBe(nestedExpectedNodeId);

      // Corresponding graph file node must have identical id
      const nestedNode = p.capturedNodes.find((n) => n.id === nestedExpectedNodeId);
      expect(nestedNode).toBeDefined();
      expect(nestedNode.id).toBe(nestedSearchable.nodeId);
      expect(nestedNode.type).toBe(ReactorNodeType.FILE);
    });

    it("symlink searchable carries aligned nodeId and logicalKey id", async () => {
      // Create a symlink in the project directory
      const linkPath = path.join(tempDir, "src", "link-to-nested.ts");
      try {
        fs.symlinkSync(path.join(tempDir, "src", "a", "b", "nested.ts"), linkPath);
      } catch {
        // Skip if symlink not supported by platform
        return;
      }

      const ctx = makeContext();
      const p = new CapturingProcessor({}, ctx);
      await p.process(testProject, { skipGc: true });

      const fqn = projectFqn(testProject);
      const symlinkSearchable = p.capturedSearchables.find((s) => s.path.endsWith("src/link-to-nested.ts"));
      expect(symlinkSearchable).toBeDefined();

      const symlinkLogicalKey = pathLogicalKey(fqn, "src/link-to-nested.ts");
      const expectedSymlinkNodeId = nodeId(symlinkLogicalKey);

      expect(symlinkSearchable.id).toBe(symlinkLogicalKey);
      expect(symlinkSearchable.nodeId).toBe(expectedSymlinkNodeId);
    });
  });

  describe("SystemGraphManager searchNodes resolution", () => {
    it("resolves persisted nodes by numeric nodeId and logicalKey id without double-hashing", async () => {
      const fqn = "test.search-fixture@1.0.0";
      const relPath = "src/a/b/nested.ts";
      const logicalKey = pathLogicalKey(fqn, relPath);
      const targetNodeId = nodeId(logicalKey);

      const persistedNode = {
        id: targetNodeId,
        index: targetNodeId,
        key: `${targetNodeId}`,
        name: "nested.ts",
        nameSpace: "test",
        version: "1.0.0",
        type: ReactorNodeType.FILE,
        description: "File src/a/b/nested.ts",
        data: { relativePath: relPath, projectFqn: fqn },
      };

      const mockSearchService = {
        search: jest.fn().mockResolvedValue({
          total: 2,
          results: [
            // Hit 1: new format with explicit numeric nodeId
            {
              id: logicalKey,
              nodeId: targetNodeId,
              name: "file_src/a/b/nested.ts",
              nameSpace: "test",
              version: "1.0.0",
              source: "export const nestedValue = 42;",
            },
            // Hit 2: string logicalKey as id (without explicit nodeId)
            {
              id: pathLogicalKey(fqn, "README.md"),
              name: "document_README.md",
              nameSpace: "test",
              version: "1.0.0",
              source: "# Search Fixture Doc",
            },
          ],
        }),
      };

      const ctx = makeContext();
      const manager = new SystemGraphManager({}, ctx);
      manager.setSearchService(mockSearchService as any);

      // Mock getNodes to return the persisted node for targetNodeId
      const getNodesSpy = jest.spyOn(manager, "getNodes").mockImplementation(async (ids: number[]) => {
        return ids.map((id) => {
          if (id === targetNodeId) return persistedNode;
          return {
            id,
            index: id,
            key: `${id}`,
            name: `#${id}`,
            type: ReactorNodeType.PROCESS,
            description: "Unresolved node",
          } as any;
        });
      });

      const results = await manager.searchNodes("nested", { nameSpace: "test", name: "search-fixture" });

      expect(getNodesSpy).toHaveBeenCalledWith([targetNodeId, nodeId(pathLogicalKey(fqn, "README.md"))]);

      // Hit 1 matched persisted node, returned persisted node directly
      expect(results[0]).toEqual(persistedNode);
      expect(results[0].type).toBe(ReactorNodeType.FILE);

      // Hit 2 unpersisted fallback returned synthetic node with type FILE (not DATASTORE)
      expect(results[1].id).toBe(nodeId(pathLogicalKey(fqn, "README.md")));
      expect(results[1].type).toBe(ReactorNodeType.FILE);
    });
  });

  describe("GraphQL ReactorNodesByNameAndNameSpace resolver", () => {
    it("delegates to SystemGraphManager.searchNodes and does not hardcode DATASTORE", async () => {
      const ctx = makeContext();
      const resolverInstance = new ReactorSystemGraph();

      const mockSearchNodesResult = [
        {
          id: 12345,
          name: "nested.ts",
          nameSpace: "test",
          type: ReactorNodeType.FILE,
          description: "File src/a/b/nested.ts",
        },
      ];

      const mockGraphService = {
        searchNodes: jest.fn().mockResolvedValue(mockSearchNodesResult),
      };

      ctx.setService("reactor.SystemGraphManager@1.0.0", mockGraphService);

      const result = await resolverInstance.ReactorNodesByNameAndNameSpace(
        null,
        {
          nameSpace: "test",
          name: "search-fixture",
          term: "nested",
          paging: { page: 1, pageSize: 10 },
        },
        ctx
      );

      expect(mockGraphService.searchNodes).toHaveBeenCalledWith("nested", {
        nameSpace: "test",
        name: "search-fixture",
        limit: 10,
      });

      expect(result.nodes).toEqual(mockSearchNodesResult);
      expect(result.nodes[0].type).not.toBe(ReactorNodeType.DATASTORE);
      expect(result.nodes[0].type).toBe(ReactorNodeType.FILE);
    });
  });
});
