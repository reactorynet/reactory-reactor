import fs from "fs";
import os from "os";
import path from "path";
import NodeJSProjectProcessor from "../ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor";
import { analyseTypeScriptFile } from "./analyzers/TypeScriptAnalyzer";
import {
  nodeId,
  parseAncestry,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
} from "./GraphIdentity";
import { writeProject, cleanup } from "./testUtils";
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

  describe("process() folder hierarchy persistence (batch vs interactive parity)", () => {
    let nestedDir: string;
    let nestedProject: any;

    beforeEach(() => {
      const res = writeProject(
        {
          "package.json": JSON.stringify({ name: "nested-fixture", version: "1.0.0" }),
          "README.md": "# root doc\n",
          "src/a/b/hello.ts": "export const hello = () => 'hi';\n",
          "docs/guide.md": "# Guide\n\nSee [hello](../src/a/b/hello.ts).\n",
        },
        { name: "nested-fixture", nameSpace: "test", version: "1.0.0" }
      );
      nestedDir = res.dir;
      nestedProject = res.project;
    });

    afterEach(() => {
      cleanup(nestedDir);
    });

    it("creates intermediate FOLDER nodes and parents files under their immediate folder (not root)", async () => {
      class CapturingProcessor extends NodeJSProjectProcessor {
        public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
        protected async persistGraph(nodes: any[], edges: any[]) {
          this.captured = { nodes, edges };
        }
        protected async indexSearchables() {}
      }

      const p = new CapturingProcessor({}, makeContext());
      await p.process(nestedProject);

      const fqn = projectFqn(nestedProject);
      const rootId = nodeId(projectLogicalKey(nestedProject));
      const root = p.captured.nodes.find((n) => n.id === rootId);
      expect(root).toBeDefined();

      // Folder nodes must exist
      const srcFolderId = nodeId(pathLogicalKey(fqn, "src"));
      const srcAFolderId = nodeId(pathLogicalKey(fqn, "src/a"));
      const srcABFolderId = nodeId(pathLogicalKey(fqn, "src/a/b"));
      const docsFolderId = nodeId(pathLogicalKey(fqn, "docs"));

      const srcFolder = p.captured.nodes.find((n) => n.id === srcFolderId);
      const srcAFolder = p.captured.nodes.find((n) => n.id === srcAFolderId);
      const srcABFolder = p.captured.nodes.find((n) => n.id === srcABFolderId);
      const docsFolder = p.captured.nodes.find((n) => n.id === docsFolderId);

      expect(srcFolder).toBeDefined();
      expect(srcFolder.type).toBe(ReactorNodeType.FOLDER);
      expect(srcFolder.parentId).toBe(rootId);

      expect(srcAFolder).toBeDefined();
      expect(srcAFolder.type).toBe(ReactorNodeType.FOLDER);
      expect(srcAFolder.parentId).toBe(srcFolderId);

      expect(srcABFolder).toBeDefined();
      expect(srcABFolder.type).toBe(ReactorNodeType.FOLDER);
      expect(srcABFolder.parentId).toBe(srcAFolderId);

      expect(docsFolder).toBeDefined();
      expect(docsFolder.type).toBe(ReactorNodeType.FOLDER);

      // File under 3-level folder must be parented to the immediate folder
      const helloFileId = nodeId(pathLogicalKey(fqn, "src/a/b/hello.ts"));
      const helloFile = p.captured.nodes.find((n) => n.id === helloFileId);
      expect(helloFile).toBeDefined();
      expect(helloFile.type).toBe(ReactorNodeType.FILE);
      expect(helloFile.parentId).toBe(srcABFolderId); // NOT rootId
      expect(helloFile.parentId).not.toBe(rootId);

      // id formula for file must be unchanged (full relative path)
      expect(helloFile.id).toBe(helloFileId);

      // Root level document
      const readmeId = nodeId(pathLogicalKey(fqn, "README.md"));
      const readme = p.captured.nodes.find((n) => n.id === readmeId);
      expect(readme).toBeDefined();
      expect(readme.type).toBe(ReactorNodeType.DOCUMENT);
      expect(readme.parentId).toBe(rootId); // top-level lives under root

      // Document under docs/
      const guideId = nodeId(pathLogicalKey(fqn, "docs/guide.md"));
      const guide = p.captured.nodes.find((n) => n.id === guideId);
      expect(guide).toBeDefined();
      expect(guide.type).toBe(ReactorNodeType.DOCUMENT);
      expect(guide.parentId).toBe(docsFolderId);

      // Ancestry depth sanity: root -> src -> a -> b -> file
      const helloKey = helloFile.key;
      const ancestry = parseAncestry(helloKey);
      expect(ancestry.length).toBeGreaterThanOrEqual(5); // root|src|a|b|file
      expect(ancestry[0]).toBe(rootId);
      expect(ancestry[ancestry.length - 1]).toBe(helloFileId);
    });

    it("no file or document (except root-level) has parentId === root after process", async () => {
      class CapturingProcessor extends NodeJSProjectProcessor {
        public captured: { nodes: any[] } = { nodes: [] };
        protected async persistGraph(nodes: any[]) {
          this.captured = { nodes };
        }
        protected async indexSearchables() {}
      }
      const p = new CapturingProcessor({}, makeContext());
      await p.process(nestedProject);

      const fqn = projectFqn(nestedProject);
      const rootId = nodeId(projectLogicalKey(nestedProject));

      const rootLevelFiles = p.captured.nodes.filter(
        (n) =>
          (n.type === ReactorNodeType.FILE || n.type === ReactorNodeType.DOCUMENT) &&
          n.parentId === rootId &&
          n.id !== rootId
      );
      // All of them must be true root-level (no '/' in relativePath)
      const nonRootLevelWithRootParent = rootLevelFiles.filter((n) => {
        const rel = (n.data && n.data.relativePath) || "";
        return rel.includes("/");
      });
      expect(nonRootLevelWithRootParent.length).toBe(0);
      // Sanity: we do have root-level files (package.json + README.md)
      expect(rootLevelFiles.length).toBeGreaterThanOrEqual(2);
    });
  });
});
