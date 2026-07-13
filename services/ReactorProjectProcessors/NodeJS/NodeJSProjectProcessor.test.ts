import NodeJSProjectProcessor from "./NodeJSProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";

describe("NodeJSProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new NodeJSProjectProcessor({}, ctx);

  it("detects a NodeJS project via package.json", () => {
    const { dir, project } = writeProject({
      "package.json": JSON.stringify({ name: "svc", version: "1.0.0" }),
    });
    expect(processor.supportsProject(project)).toBe(true);
    expect(processor.getProjectTypes(project)).toEqual(["nodejs"]);
    cleanup(dir);
  });

  it("flags typescript and react sub-types from dependencies", () => {
    const { dir, project } = writeProject({
      "package.json": JSON.stringify({
        name: "svc",
        dependencies: { react: "18" },
        devDependencies: { typescript: "5" },
      }),
    });
    const types = processor.getProjectTypes(project);
    expect(types).toEqual(expect.arrayContaining(["nodejs", "typescript", "react-web"]));
    cleanup(dir);
  });

  it("does not claim a project without package.json", () => {
    const { dir, project } = writeProject({ "main.py": "print(1)" });
    expect(processor.supportsProject(project)).toBe(false);
    cleanup(dir);
  });
});
