import FileProjectProcessor from "./FileProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("FileProjectProcessor (generic fallback)", () => {
  const ctx = makeContext();
  const processor = new FileProjectProcessor({}, ctx);

  it("claims any project with a repoPath and reports no specific type", () => {
    const { dir, project } = writeProject({ "notes.txt": "hi" });
    expect(processor.supportsProject(project)).toBe(true);
    expect(processor.getProjectTypes(project)).toEqual([]);
    cleanup(dir);
    expect(processor.supportsProject({})).toBe(false);
  });

  it("browses folders and files generically", async () => {
    const { dir, project } = writeProject({
      "docs/readme.md": "# hi",
      "data.csv": "a,b\n1,2",
    });
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("docs");
    expect(names).toContain("data.csv");
    expect(children[0].type).toBe(ReactorNodeType.FOLDER);
    cleanup(dir);
  });
});
