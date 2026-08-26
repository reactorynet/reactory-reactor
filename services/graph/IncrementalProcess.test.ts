import fs from "fs";
import path from "path";
import NodeJSProjectProcessor from "../ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor";
import { writeProject, cleanup } from "./testUtils";
import { nodeId, pathLogicalKey, projectFqn } from "./GraphIdentity";
import { ReactorNodeType } from "../../types/model.types";
import { fileContentHash } from "../ReactorProjectProcessors/BaseProjectProcessor";

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

describe("Session 08 — Incremental Re-Index by Content Hash", () => {
  let tempDir: string;
  let testProject: any;

  beforeEach(() => {
    const res = writeProject(
      {
        "package.json": JSON.stringify({ name: "inc-fixture", version: "1.0.0" }),
        "README.md": "# Incremental Fixture\n",
        "src/a.ts": "export const a = 1;\nexport function getA() { return a; }\n",
        "src/b.ts": "import { a } from './a';\nexport const b = a + 1;\n",
      },
      { name: "inc-fixture", nameSpace: "test", version: "1.0.0" }
    );
    tempDir = res.dir;
    testProject = res.project;
    testProject.id = "proj-inc-123";
  });

  afterEach(() => {
    cleanup(tempDir);
    jest.restoreAllMocks();
  });

  class TestableIncrementalProcessor extends NodeJSProjectProcessor {
    public persistedNodesMap = new Map<number, any>();
    public persistedEdgesMap = new Map<number, any>();
    public analyseCount = 0;

    protected async loadPreviousNodes(project: any) {
      const prevMap = new Map<number, any>();
      for (const [id, node] of this.persistedNodesMap.entries()) {
        if (node.projectId === String(project.id) && (node.type === "FILE" || node.type === "DOCUMENT")) {
          prevMap.set(id, { id: node.id, contentHash: node.contentHash, parentId: node.parentId, type: node.type });
        }
      }
      return prevMap;
    }

    protected async loadDescendantNodeIds(parentId: number, projectId: string) {
      const ids: number[] = [];
      for (const [id, node] of this.persistedNodesMap.entries()) {
        if (node.projectId === String(projectId) && node.parentId === parentId) {
          ids.push(id);
        }
      }
      return ids;
    }

    protected async loadEdgeIdsTouching(nodeIds: number[], projectId: string) {
      const edgeIds: number[] = [];
      for (const [id, edge] of this.persistedEdgesMap.entries()) {
        if (edge.projectId === String(projectId) && (nodeIds.includes(edge.source) || nodeIds.includes(edge.target))) {
          edgeIds.push(id);
        }
      }
      return edgeIds;
    }

    protected async touchNodes(ids: number[], meta: { runId: string; indexedAt: Date }) {
      for (const id of ids) {
        const node = this.persistedNodesMap.get(id);
        if (node) {
          node.runId = meta.runId;
          node.indexedAt = meta.indexedAt;
        }
      }
    }

    protected async touchEdges(ids: number[], meta: { runId: string; indexedAt: Date }) {
      for (const id of ids) {
        const edge = this.persistedEdgesMap.get(id);
        if (edge) {
          edge.runId = meta.runId;
          edge.indexedAt = meta.indexedAt;
        }
      }
    }

    protected async persistGraph(nodes: any[], edges: any[], meta?: any) {
      for (const n of nodes) {
        if (n && n.id !== undefined) {
          this.persistedNodesMap.set(n.id, { ...n, ...meta });
        }
      }
      for (const e of edges) {
        if (e && e.id !== undefined) {
          this.persistedEdgesMap.set(e.id, { ...e, ...meta });
        }
      }
    }

    protected async indexSearchables(_project: any, _searchables: any[]) {
      // noop
    }

    protected async analyseFileFull(fileNode: any) {
      this.analyseCount++;
      return super.analyseFileFull(fileNode);
    }

    public runGC(projectId: string, currentRunId: string) {
      for (const [id, node] of this.persistedNodesMap.entries()) {
        if (node.projectId === String(projectId) && node.runId !== currentRunId && node.runId !== "manual") {
          this.persistedNodesMap.delete(id);
        }
      }
      for (const [id, edge] of this.persistedEdgesMap.entries()) {
        if (edge.projectId === String(projectId) && edge.runId !== currentRunId && edge.runId !== "manual") {
          this.persistedEdgesMap.delete(id);
        }
      }
    }
  }

  it("fileContentHash computes correct SHA-256 hex string", () => {
    const hash = fileContentHash("hello world");
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("first process analyses all files and stamps contentHash", async () => {
    const ctx = makeContext();
    const processor = new TestableIncrementalProcessor({}, ctx);

    await processor.process(testProject, { runId: "run-1", skipGc: true });

    // README.md, src/a.ts, src/b.ts -> 3 analysable files (package.json has no analyzer)
    expect(processor.analyseCount).toBe(3);

    const fqn = projectFqn(testProject);
    const aNodeId = nodeId(pathLogicalKey(fqn, "src/a.ts"));
    const aNode = processor.persistedNodesMap.get(aNodeId);

    expect(aNode).toBeDefined();
    expect(aNode.contentHash).toBeDefined();
    expect(aNode.contentHash).toBe(fileContentHash(fs.readFileSync(path.join(tempDir, "src/a.ts"), "utf-8")));
  });

  it("second process on unchanged files skips analyseFileFull and preserves graph through GC", async () => {
    const ctx = makeContext();
    const processor = new TestableIncrementalProcessor({}, ctx);

    // Initial run
    await processor.process(testProject, { runId: "run-1", skipGc: true });
    const initialSymbolCount = Array.from(processor.persistedNodesMap.values()).filter((n) => n.data?.kind === "symbol").length;
    expect(initialSymbolCount).toBeGreaterThan(0);

    // Reset analyse counter
    processor.analyseCount = 0;

    // Second run (incremental)
    await processor.process(testProject, { runId: "run-2", skipGc: true });

    // Zero files re-analysed
    expect(processor.analyseCount).toBe(0);

    // Run GC with run-2
    processor.runGC("proj-inc-123", "run-2");

    // All symbols and edges should still exist because they were touched with run-2
    const postGCSymbolCount = Array.from(processor.persistedNodesMap.values()).filter((n) => n.data?.kind === "symbol").length;
    expect(postGCSymbolCount).toBe(initialSymbolCount);
  });

  it("modifying one file re-analyses only that file", async () => {
    const ctx = makeContext();
    const processor = new TestableIncrementalProcessor({}, ctx);

    // Initial run
    await processor.process(testProject, { runId: "run-1", skipGc: true });
    expect(processor.analyseCount).toBe(3);

    // Modify src/a.ts
    fs.writeFileSync(path.join(tempDir, "src/a.ts"), "export const a = 2;\nexport function getA2() { return a; }\n");

    // Reset counter
    processor.analyseCount = 0;

    // Incremental run
    await processor.process(testProject, { runId: "run-2", skipGc: true });

    // Exactly 1 file (src/a.ts) re-analysed
    expect(processor.analyseCount).toBe(1);

    // Verify info log includes skip counts
    expect(ctx.info).toHaveBeenCalledWith(
      expect.stringMatching(/process inc-fixture: analysed=1 skipped=3/)
    );
  });

  it("forceFull: true re-analyses all files even when content hash matches", async () => {
    const ctx = makeContext();
    const processor = new TestableIncrementalProcessor({}, ctx);

    // Initial run
    await processor.process(testProject, { runId: "run-1", skipGc: true });
    expect(processor.analyseCount).toBe(3);

    // Reset counter
    processor.analyseCount = 0;

    // Force full run
    await processor.process(testProject, { runId: "run-2", forceFull: true, skipGc: true });

    // All 3 analysable files re-analysed
    expect(processor.analyseCount).toBe(3);
    expect(ctx.info).toHaveBeenCalledWith(
      expect.stringMatching(/process inc-fixture: analysed=4 skipped=0/)
    );
  });
});
