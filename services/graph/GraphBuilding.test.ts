import fs from "fs";
import os from "os";
import path from "path";
import NodeJSProjectProcessor from "../ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor";
import { analyseTypeScriptFile } from "./analyzers/TypeScriptAnalyzer";
import {
  nodeId,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
} from "./GraphIdentity";
import { ReactorNodeType } from "../../types/model.types";

/** Minimal in-memory Reactory context for driving processors without DI/Mongo. */
const makeContext = () => {
  const store = new Map<string, any>();
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
    getService: () => null,
    __store: store,
  } as any;
};

const writeFixture = (): { dir: string; project: any } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-graph-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { typescript: "*" } })
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules")); // must be ignored by the walker
  fs.writeFileSync(path.join(dir, "node_modules", "ignored.ts"), "export const nope = 1;");
  fs.writeFileSync(
    path.join(dir, "src", "util.ts"),
    `export class Helper {\n  doThing() { return 1; }\n}\nexport function helper() { return 2; }\nexport const CONST = 3;\n`
  );
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    `import { Helper, helper } from './util';\nimport _ from 'lodash';\nexport function main() { return new Helper(); }\n`
  );
  const project = {
    id: "fixture-id",
    name: "fixture",
    nameSpace: "test",
    version: "1.0.0",
    repoPath: dir,
  };
  return { dir, project };
};

describe("Graph building (NodeJS/TypeScript)", () => {
  let dir: string;
  let project: any;
  let ctx: any;
  let processor: NodeJSProjectProcessor;

  beforeAll(() => {
    ({ dir, project } = writeFixture());
    ctx = makeContext();
    processor = new NodeJSProjectProcessor({}, ctx);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects a NodeJS/TypeScript project", () => {
    expect(processor.supportsProject(project)).toBe(true);
    expect(processor.getProjectTypes(project)).toEqual(
      expect.arrayContaining(["nodejs", "typescript"])
    );
  });

  it("produces a deterministic project root node", async () => {
    const root = await processor.getProjectNode(project);
    expect(root.id).toBe(nodeId(projectLogicalKey(project)));
    expect(root.type).toBe(ReactorNodeType.SYSTEM);
    expect(root.parentId).toBeNull();
  });

  it("walks the top-level tree, ignoring node_modules", async () => {
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("src");
    expect(names).toContain("package.json");
    expect(names).not.toContain("node_modules");
    // folders sort before files
    expect(children[0].type).toBe(ReactorNodeType.FOLDER);
  });

  it("expands folders and files with stable ids", async () => {
    const root = await processor.getProjectNode(project);
    const rootChildren = await processor.getChildrenForNode(root as any, root.key, null, null);
    const src = rootChildren.find((c) => c.name === "src");
    expect(src).toBeDefined();
    const srcChildren = await processor.getChildrenForNode(src as any, src!.key, null, null);
    const indexFile = srcChildren.find((c) => c.name === "index.ts");
    expect(indexFile).toBeDefined();
    expect(indexFile!.type).toBe(ReactorNodeType.FILE);
    expect(indexFile!.data.language).toBe("typescript");
    // id derived from the project fqn + relative path
    expect(indexFile!.id).toBe(nodeId(pathLogicalKey(projectFqn(project), "src/index.ts")));
  });

  it("extracts symbols from a TypeScript file", async () => {
    const root = await processor.getProjectNode(project);
    const rootChildren = await processor.getChildrenForNode(root as any, root.key, null, null);
    const src = rootChildren.find((c) => c.name === "src");
    const srcChildren = await processor.getChildrenForNode(src as any, src!.key, null, null);
    const utilFile = srcChildren.find((c) => c.name === "util.ts")!;
    const symbols = await processor.getChildrenForNode(utilFile as any, utilFile.key, null, null);
    const byName = symbols.map((s) => s.name);
    expect(byName).toContain("Helper");
    expect(byName).toContain("helper");
    expect(byName).toContain("CONST");
    // class method surfaced one level down
    const helperClass = symbols.find((s) => s.name === "Helper")!;
    expect(helperClass.type).toBe(ReactorNodeType.PROCESS);
  });

  it("process() assembles the full graph (nodes + edges + searchables)", async () => {
    // Subclass to capture what process() would persist/index, without Mongo.
    class CapturingProcessor extends NodeJSProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      public capturedSearchables: any[] = [];
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables(_project: any, searchables: any[]) {
        this.capturedSearchables = searchables;
      }
    }

    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);

    const nodeNames = p.captured.nodes.map((n) => n.name);
    // project root + files + symbols + external dependency
    expect(nodeNames).toContain("fixture"); // root (project name)
    expect(nodeNames).toContain("index.ts");
    expect(nodeNames).toContain("util.ts");
    expect(nodeNames).toContain("Helper");
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("lodash"); // external dependency node

    // edges: index.ts -> util.ts (resolved) and index.ts -> lodash (external)
    expect(p.captured.edges.length).toBeGreaterThanOrEqual(2);

    // one searchable per source file (package.json, index.ts, util.ts)
    expect(p.capturedSearchables.length).toBe(3);
    expect(p.capturedSearchables.every((s) => typeof s.source === "string")).toBe(true);
  });

  it("builds import edges: resolved relative + external npm", async () => {
    const root = await processor.getProjectNode(project);
    const rootChildren = await processor.getChildrenForNode(root as any, root.key, null, null);
    const src = rootChildren.find((c) => c.name === "src");
    const srcChildren = await processor.getChildrenForNode(src as any, src!.key, null, null);
    const indexFile = srcChildren.find((c) => c.name === "index.ts")!;

    const analysis = analyseTypeScriptFile(indexFile as any, ctx);

    // resolved relative import -> util.ts
    const utilId = nodeId(pathLogicalKey(projectFqn(project), "src/util.ts"));
    const relEdge = analysis.edges.find((e) => e.target === utilId);
    expect(relEdge).toBeDefined();
    expect(relEdge!.source).toBe(indexFile.id);
    expect(relEdge!.types).toContain("DEPENDENCY");

    // external npm import -> lodash
    const extEdge = analysis.edges.find((e) => e.data?.external === true);
    expect(extEdge).toBeDefined();
    expect(extEdge!.title).toBe("lodash");
    expect(analysis.externals.some((n) => n.name === "lodash")).toBe(true);

    // symbol: main function
    expect(analysis.symbols.some((s) => s.name === "main")).toBe(true);
  });
});
