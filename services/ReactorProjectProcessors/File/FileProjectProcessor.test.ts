import FileProjectProcessor from "./FileProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("FileProjectProcessor (generic fallback)", () => {
  it("claims any project with a repoPath and reports no specific type", () => {
    const ctx = makeContext();
    const processor = new FileProjectProcessor({}, ctx);
    const { dir, project } = writeProject({ "notes.txt": "hi" });
    expect(processor.supportsProject(project)).toBe(true);
    expect(processor.getProjectTypes(project)).toEqual([]);
    cleanup(dir);
    expect(processor.supportsProject({})).toBe(false);
  });

  it("browses folders and files generically", async () => {
    const ctx = makeContext();
    const processor = new FileProjectProcessor({}, ctx);
    const { dir, project } = writeProject({
      "docs/readme.md": "# hi",
      "data.csv": "a,b\n1,2",
    }, { name: "generic-browse" });
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("docs");
    expect(names).toContain("data.csv");
    expect(children[0].type).toBe(ReactorNodeType.FOLDER);
    cleanup(dir);
  });

  it("respects .gitignore patterns when listing files and browsing folders", async () => {
    const ctx = makeContext();
    const processor = new FileProjectProcessor({}, ctx);
    const { dir, project } = writeProject({
      "docs/readme.md": "# hi",
      "docs/ignored_file.tmp": "binary",
      "node_modules/some_lib/index.js": "console.log()",
      "dist/bundle.js": "build artifact",
      ".gitignore": "node_modules/\ndist/\n*.tmp\n",
    }, { name: "gitignore-test" });

    const specs = processor.getFileSpecs(project);
    const paths = specs.map((s) => s.path);
    
    expect(paths.some(p => p.endsWith("docs/readme.md"))).toBe(true);
    expect(paths.some(p => p.endsWith(".gitignore"))).toBe(true);
    
    expect(paths.some(p => p.endsWith("docs/ignored_file.tmp"))).toBe(false);
    expect(paths.some(p => p.includes("node_modules"))).toBe(false);
    expect(paths.some(p => p.includes("dist"))).toBe(false);

    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    
    expect(names).toContain("docs");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("dist");

    cleanup(dir);
  });

  it("detects submodules and treats them as separate projects (does not walk into them)", async () => {
    const ctx = makeContext();
    const processor = new FileProjectProcessor({}, ctx);
    const { dir, project } = writeProject({
      "src/index.js": "console.log('main')",
      "submodules/my-submodule/src/index.js": "console.log('sub')",
      "submodules/my-submodule/.git": "gitdir: ../../.git/modules/submodule",
    }, { name: "submodule-test" });

    const specs = processor.getFileSpecs(project);
    const paths = specs.map((s) => s.path);

    expect(paths.some(p => p.endsWith("src/index.js"))).toBe(true);
    expect(paths.some(p => p.includes("submodules/my-submodule/src/index.js"))).toBe(false);

    expect(project.submodules).toBeDefined();
    expect(project.submodules.some(s => s.endsWith("submodules/my-submodule"))).toBe(true);

    cleanup(dir);
  });
});
