import path from "path";
import NodeJSProjectProcessor from "../ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor";
import { publicNode } from "../SystemGraphManager";
import { writeProject, cleanup, makeTestNode } from "./testUtils";
import { ReactorNodeType, ReactorLinkType } from "../../types/model.types";
import { nodeId, projectFqn, symbolLogicalKey } from "./GraphIdentity";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";

const makeContext = () => {
  const store = new Map<string, any>();
  const logs: Array<{ level: string; msg: string; meta?: any }> = [];
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    clearValue: async (k: string) => {
      store.delete(k);
    },
    warn: (msg: string, meta?: any) => logs.push({ level: "warn", msg, meta }),
    info: (msg: string, meta?: any) => logs.push({ level: "info", msg, meta }),
    error: (msg: string, meta?: any) => logs.push({ level: "error", msg, meta }),
    debug: (msg: string, meta?: any) => logs.push({ level: "debug", msg, meta }),
    getService: () => null,
    __store: store,
    __logs: logs,
  } as any;
};

describe("Session 14: Observability, Cache Busting, Tenancy & Path Redaction", () => {
  describe("3.4 Path Redaction (publicNode)", () => {
    it("redacts absolute filesystem paths from source and data.path / data.repoPath", () => {
      const node = {
        id: 12345,
        name: "test.ts",
        type: ReactorNodeType.FILE,
        source: "/Users/dev/project/src/test.ts",
        data: {
          path: "/Users/dev/project/src/test.ts",
          relativePath: "src/test.ts",
          repoPath: "/Users/dev/project",
          language: "typescript",
        },
      };

      const redacted = publicNode(node);

      expect(redacted.source).toBe("src/test.ts");
      expect(redacted.data.path).toBe("src/test.ts");
      expect(redacted.data.repoPath).toBeUndefined();
      expect(redacted.data.language).toBe("typescript");
    });

    it("falls back to '[redacted]' when relativePath is not present on absolute source", () => {
      const node = {
        id: 12345,
        name: "root",
        type: ReactorNodeType.SYSTEM,
        source: "/Users/dev/project",
        data: {},
      };

      const redacted = publicNode(node);
      expect(redacted.source).toBe("[redacted]");
      expect(redacted.data.repoPath).toBeUndefined();
    });

    it("leaves relative source paths unchanged", () => {
      const node = {
        id: 12345,
        name: "test.ts",
        type: ReactorNodeType.FILE,
        source: "src/test.ts",
        data: { relativePath: "src/test.ts" },
      };

      const redacted = publicNode(node);
      expect(redacted.source).toBe("src/test.ts");
    });

    it("handles null / undefined nodes safely", () => {
      expect(publicNode(null as any)).toBeNull();
      expect(publicNode(undefined as any)).toBeUndefined();
    });
  });

  describe("3.1 Structured Process Metrics", () => {
    let dir: string;
    let project: any;

    beforeAll(() => {
      ({ dir, project } = writeProject({
        "package.json": JSON.stringify({ name: "metrics-proj", version: "1.0.0" }),
        "src/a.ts": "export class ServiceA {}",
        "src/b.ts": "export class ServiceB {}",
        "README.md": "# Docs\n\nSee `ServiceA`.\n",
      }));
    });
    afterAll(() => cleanup(dir));

    it("emits structured GraphProcessMetrics with complete counts and duration", async () => {
      const ctx = makeContext();
      class CapturingProcessor extends NodeJSProjectProcessor {
        public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
        protected async persistGraph(nodes: any[], edges: any[], meta?: any) {
          this.captured = { nodes, edges };
        }
        protected async indexSearchables() {}
      }

      const p = new CapturingProcessor({}, ctx);
      await p.process(project, { skipGc: true, linkDocMentions: true });

      const metrics = p.lastMetrics;
      expect(metrics).toBeDefined();
      expect(metrics!.projectId).toBeDefined();
      expect(metrics!.projectFqn).toBeDefined();
      expect(metrics!.runId).toBeDefined();
      expect(metrics!.filesDiscovered).toBe(4);
      expect(metrics!.filesAnalysed).toBeGreaterThanOrEqual(3);
      expect(metrics!.nodesUpserted).toBeGreaterThan(0);
      expect(metrics!.edgesUpserted).toBeGreaterThan(0);
      expect(metrics!.durationMs).toBeGreaterThanOrEqual(0);
      expect(metrics!.errors).toBe(0);
      expect(metrics!.byLanguage).toMatchObject({
        typescript: 2,
        markdown: 1,
      });

      const logged = ctx.__logs.find((l: any) => l.msg === "graph.process.complete");
      expect(logged).toBeDefined();
    });
  });

  describe("3.2 Cache Invalidation", () => {
    let dir: string;
    let project: any;

    beforeAll(() => {
      ({ dir, project } = writeProject({
        "package.json": JSON.stringify({ name: "cache-proj", version: "1.0.0" }),
        "src/index.ts": "export const a = 1;",
      }));
    });
    afterAll(() => cleanup(dir));

    it("clears cached node values (REACTOR_NODE_*) after process", async () => {
      const ctx = makeContext();
      class CapturingProcessor extends NodeJSProjectProcessor {
        protected async persistGraph() {}
        protected async indexSearchables() {}
      }

      const p = new CapturingProcessor({}, ctx);
      const rootNode = await p.getProjectNode(project);
      await ctx.setValue(`REACTOR_NODE_${rootNode.id}`, { id: rootNode.id, stale: true });
      expect(await ctx.getValue(`REACTOR_NODE_${rootNode.id}`)).toBeDefined();

      await p.process(project, { skipGc: true });

      // Cache key for the root node should be cleared/bust
      expect(await ctx.getValue(`REACTOR_NODE_${rootNode.id}`)).toBeUndefined();
    });
  });

  describe("3.3 Tenancy / Partner Scoping", () => {
    it("stamps partnerId and organizationId in persistGraph metadata when present", async () => {
      const { dir, project } = writeProject({
        "package.json": JSON.stringify({ name: "tenant-proj", version: "1.0.0" }),
        "src/index.ts": "export const x = 1;",
      });
      project.partnerId = "partner-123";
      project.organizationId = "org-456";

      const ctx = makeContext();
      let lastMeta: any;
      class CapturingProcessor extends NodeJSProjectProcessor {
        protected async persistGraph(nodes: any[], edges: any[], meta?: any) {
          lastMeta = meta;
        }
        protected async indexSearchables() {}
      }

      const p = new CapturingProcessor({}, ctx);
      await p.process(project, { skipGc: true });

      expect(lastMeta).toBeDefined();
      expect(lastMeta.partnerId).toBe("partner-123");
      expect(lastMeta.organizationId).toBe("org-456");
      cleanup(dir);
    });
  });
});
