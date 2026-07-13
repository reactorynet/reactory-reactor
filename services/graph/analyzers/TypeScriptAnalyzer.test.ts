import path from "path";
import { analyseTypeScriptFile } from "./TypeScriptAnalyzer";
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
});
