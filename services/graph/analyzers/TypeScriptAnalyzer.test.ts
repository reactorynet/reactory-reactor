import path from "path";
import fs from "fs";
import { analyseTypeScriptFile } from "./TypeScriptAnalyzer";
import { clearTsconfigCache, findTsconfigPath, loadTsconfig, resolveTsconfigImport } from "./tsconfigPaths";
import {
  makeContext,
  writeProject,
  cleanup,
  TestProject,
} from "../testUtils";
import {
  nodeId,
  pathLogicalKey,
  projectFqn,
  symbolLogicalKey,
} from "../GraphIdentity";
import { ReactorNode, ReactorNodeType } from "../../../types/model.types";

/** Build a FILE node the way the base processor would, for direct analysis. */
const fileNode = (project: TestProject, rel: string): ReactorNode => {
  const fqn = projectFqn(project);
  const id = nodeId(pathLogicalKey(fqn, rel));
  return {
    id,
    index: id,
    name: path.basename(rel),
    key: `${nodeId(fqn)}|${id}`,
    type: ReactorNodeType.FILE,
    parentId: nodeId(fqn),
    providerId: "reactor.NodeJSProjectProcessor@1.0.0",
    nameSpace: project.nameSpace,
    version: project.version,
    source: path.join(project.repoPath, rel),
    children: [],
    data: {
      path: path.join(project.repoPath, rel),
      relativePath: rel,
      repoPath: project.repoPath,
      projectFqn: fqn,
      projectId: project.id,
      kind: "file",
      language: "typescript",
    },
  } as ReactorNode;
};

describe("TypeScriptAnalyzer", () => {
  let dir: string;
  let project: TestProject;
  let fqn: string;
  const ctx = makeContext();

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "src/base.ts": `export interface Animal { speak(): string; }
export class Base {
  protected kind = 'base';
  identify() { return this.kind; }
}
`,
      "src/util.ts": `import { Base, Animal } from './base';
export class Helper extends Base implements Animal {
  speak() { return 'hi'; }
  doThing() { return this.speak(); }
}
export function helper() { return 2; }
export const CONST = 3;
export function usesHelper() { return helper(); }
`,
      "src/index.ts": `import { Helper, helper } from './util';
import _ from 'lodash';
export function main() { const h = new Helper(); return helper(); }
`,
    }));
    fqn = projectFqn(project);
  });

  afterAll(() => cleanup(dir));

  const sym = (rel: string, symbolPath: string) =>
    nodeId(symbolLogicalKey(fqn, rel, symbolPath));

  it("extracts classes, methods, functions, interfaces and exported consts", () => {
    const a = analyseTypeScriptFile(fileNode(project, "src/util.ts"), ctx);
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Helper", "speak", "doThing", "helper", "CONST", "usesHelper"])
    );
    const helperClass = a.symbols.find((s) => s.name === "Helper")!;
    expect(helperClass.data.symbolKind).toBe("class");
    const speak = a.symbols.find((s) => s.name === "speak")!;
    expect(speak.data.symbolPath).toBe("Helper.speak");
    expect(speak.type).toBe(ReactorNodeType.FUNCTION);
  });

  it("builds INHERITS and IMPLEMENTS edges to the base file", () => {
    const a = analyseTypeScriptFile(fileNode(project, "src/util.ts"), ctx);
    const helperId = sym("src/util.ts", "Helper");

    const inherits = a.edges.find((e) => e.types?.includes("INHERITS" as any));
    expect(inherits).toBeDefined();
    expect(inherits!.source).toBe(helperId);
    expect(inherits!.target).toBe(sym("src/base.ts", "Base"));
    expect(inherits!.data.relation).toBe("extends");

    const implementsEdge = a.edges.find((e) => e.types?.includes("IMPLEMENTS" as any));
    expect(implementsEdge).toBeDefined();
    expect(implementsEdge!.source).toBe(helperId);
    expect(implementsEdge!.target).toBe(sym("src/base.ts", "Animal"));
  });

  it("builds CALL edges for this.method and local function calls", () => {
    const a = analyseTypeScriptFile(fileNode(project, "src/util.ts"), ctx);
    const calls = a.edges.filter((e) => e.types?.includes("CALL" as any));

    // doThing() -> this.speak()
    const thisCall = calls.find(
      (e) => e.source === sym("src/util.ts", "Helper.doThing")
    );
    expect(thisCall).toBeDefined();
    expect(thisCall!.target).toBe(sym("src/util.ts", "Helper.speak"));

    // usesHelper() -> helper()
    const localCall = calls.find(
      (e) => e.source === sym("src/util.ts", "usesHelper")
    );
    expect(localCall).toBeDefined();
    expect(localCall!.target).toBe(sym("src/util.ts", "helper"));
  });

  it("builds cross-file CALL edges via import bindings", () => {
    const a = analyseTypeScriptFile(fileNode(project, "src/index.ts"), ctx);
    const calls = a.edges.filter((e) => e.types?.includes("CALL" as any));
    // main() calls helper() which is imported from ./util
    const crossCall = calls.find((e) => e.source === sym("src/index.ts", "main"));
    expect(crossCall).toBeDefined();
    expect(crossCall!.target).toBe(sym("src/util.ts", "helper"));
  });

  it("de-duplicates repeated relationships", () => {
    const a = analyseTypeScriptFile(fileNode(project, "src/util.ts"), ctx);
    const ids = a.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("tsconfig path aliases and baseUrl resolution (Session 10)", () => {
    let tsconfigDir: string;
    let tsconfigProject: TestProject;
    let tsconfigFqn: string;

    beforeAll(() => {
      clearTsconfigCache();
      ({ dir: tsconfigDir, project: tsconfigProject } = writeProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib/*": ["src/lib/*"],
              "@common": ["src/common/index.ts"],
              "@deep/nested/*": ["src/deep/*/impl"],
            },
          },
        }),
        "src/lib/util.ts": `export const x = 1;
export function utilFn() { return x; }
`,
        "src/common/index.ts": `export class CommonBase {
  doCommon() { return 'common'; }
}
`,
        "src/deep/sub/impl.ts": `export function deepFn() { return 42; }
`,
        "src/components/widget.ts": `export function renderWidget() { return 'widget'; }
`,
        "src/main.ts": `import { x, utilFn } from '@lib/util';
import { CommonBase } from '@common';
import { deepFn } from '@deep/nested/sub';
import { renderWidget } from 'src/components/widget';
import _ from 'lodash';
import { externalVal } from '@scope/pkg';
import { missingVal } from '@lib/missing';

export class App extends CommonBase {
  run() {
    this.doCommon();
    return utilFn() + deepFn();
  }
}
`,
      }));
      tsconfigFqn = projectFqn(tsconfigProject);
    });

    afterAll(() => {
      cleanup(tsconfigDir);
      clearTsconfigCache();
    });

    const tsSym = (rel: string, symbolPath: string) =>
      nodeId(symbolLogicalKey(tsconfigFqn, rel, symbolPath));

    it("resolves wildcard path alias (@lib/*) to in-repo file node id", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      const utilFileId = nodeId(pathLogicalKey(tsconfigFqn, "src/lib/util.ts"));

      const utilEdge = a.edges.find((e) => e.target === utilFileId);
      expect(utilEdge).toBeDefined();
      expect(utilEdge!.types).toContain("DEPENDENCY" as any);
      expect(utilEdge!.data.specifier).toBe("@lib/util");
      expect(utilEdge!.data.resolved).toBe("src/lib/util.ts");

      // Verify it was NOT registered as an external npm package
      const externalLib = a.externals.find((e) => e.name === "@lib");
      expect(externalLib).toBeUndefined();
    });

    it("resolves exact path alias (@common) to in-repo file node id", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      const commonFileId = nodeId(pathLogicalKey(tsconfigFqn, "src/common/index.ts"));

      const commonEdge = a.edges.find((e) => e.target === commonFileId);
      expect(commonEdge).toBeDefined();
      expect(commonEdge!.data.specifier).toBe("@common");
      expect(commonEdge!.data.resolved).toBe("src/common/index.ts");
    });

    it("resolves nested wildcard path alias (@deep/nested/*)", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      const deepFileId = nodeId(pathLogicalKey(tsconfigFqn, "src/deep/sub/impl.ts"));

      const deepEdge = a.edges.find((e) => e.target === deepFileId);
      expect(deepEdge).toBeDefined();
      expect(deepEdge!.data.resolved).toBe("src/deep/sub/impl.ts");
    });

    it("resolves baseUrl + relative specifier (src/components/widget)", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      const widgetFileId = nodeId(pathLogicalKey(tsconfigFqn, "src/components/widget.ts"));

      const widgetEdge = a.edges.find((e) => e.target === widgetFileId);
      expect(widgetEdge).toBeDefined();
      expect(widgetEdge!.data.resolved).toBe("src/components/widget.ts");
    });

    it("resolves cross-file INHERITS and CALL edges via path aliases", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      const appClassId = tsSym("src/main.ts", "App");
      const appRunId = tsSym("src/main.ts", "App.run");

      // App extends CommonBase (from @common -> src/common/index.ts)
      const inherits = a.edges.find(
        (e) => e.source === appClassId && e.types?.includes("INHERITS" as any)
      );
      expect(inherits).toBeDefined();
      expect(inherits!.target).toBe(tsSym("src/common/index.ts", "CommonBase"));

      // App.run() calls utilFn() (from @lib/util -> src/lib/util.ts)
      const utilCall = a.edges.find(
        (e) => e.source === appRunId && e.target === tsSym("src/lib/util.ts", "utilFn")
      );
      expect(utilCall).toBeDefined();

      // App.run() calls deepFn() (from @deep/nested/sub -> src/deep/sub/impl.ts)
      const deepCall = a.edges.find(
        (e) => e.source === appRunId && e.target === tsSym("src/deep/sub/impl.ts", "deepFn")
      );
      expect(deepCall).toBeDefined();
    });

    it("leaves unmatched bare package imports as external dependency nodes", () => {
      const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);

      // lodash
      const lodashExternal = a.externals.find((e) => e.name === "lodash");
      expect(lodashExternal).toBeDefined();
      expect(lodashExternal!.id).toBe(nodeId("npm:lodash"));

      // @scope/pkg
      const scopeExternal = a.externals.find((e) => e.name === "@scope/pkg");
      expect(scopeExternal).toBeDefined();
      expect(scopeExternal!.id).toBe(nodeId("npm:@scope/pkg"));
    });

    it("missing alias target falls back without throwing and preserves non-dangling edge (I4)", () => {
      expect(() => {
        const a = analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
        const missingExt = a.externals.find((e) => e.name === "@lib/missing");
        expect(missingExt).toBeDefined();
        const missingEdge = a.edges.find((e) => e.target === missingExt!.id);
        expect(missingEdge).toBeDefined();
      }).not.toThrow();
    });

    it("caches tsconfig parsing per project repo (read count <= 1 per batch)", () => {
      clearTsconfigCache();
      const readSpy = jest.spyOn(fs, "readFileSync");
      const initialCallCount = readSpy.mock.calls.filter((c) =>
        String(c[0]).includes("tsconfig.json")
      ).length;

      // Analyze multiple files in the same project
      analyseTypeScriptFile(fileNode(tsconfigProject, "src/main.ts"), ctx);
      analyseTypeScriptFile(fileNode(tsconfigProject, "src/lib/util.ts"), ctx);
      analyseTypeScriptFile(fileNode(tsconfigProject, "src/common/index.ts"), ctx);

      const tsconfigReads = readSpy.mock.calls.filter((c) =>
        String(c[0]).includes("tsconfig.json")
      ).length - initialCallCount;

      expect(tsconfigReads).toBeLessThanOrEqual(1);
      readSpy.mockRestore();
    });

    it("finds tsconfig in parent folders up to repo root and stops at repo boundary", () => {
      const configPath = findTsconfigPath(
        path.join(tsconfigProject.repoPath, "src/lib/util.ts"),
        tsconfigProject.repoPath
      );
      expect(configPath).toBe(path.join(tsconfigProject.repoPath, "tsconfig.json"));

      // Outside repo should return null
      const nonRepo = findTsconfigPath("/tmp/nonexistent/file.ts", "/tmp/nonexistent");
      expect(nonRepo).toBeNull();
    });
  });
});
