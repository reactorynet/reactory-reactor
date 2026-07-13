import JavaProjectProcessor from "./JavaProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";

describe("JavaProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new JavaProjectProcessor({}, ctx);

  it("instantiates", () => {
    expect(processor).toBeDefined();
  });

  it("does not claim projects without repoPath or build files", () => {
    expect(processor.supportsProject({})).toBe(false);
    const { dir, project } = writeProject({ "README.md": "# nope" });
    expect(processor.supportsProject(project)).toBe(false);
    cleanup(dir);
  });

  it("detects maven, gradle and ant projects", () => {
    const maven = writeProject({ "pom.xml": "<project/>" });
    expect(processor.supportsProject(maven.project)).toBe(true);
    expect(processor.getProjectTypes(maven.project)).toEqual(["java"]);
    cleanup(maven.dir);

    const gradle = writeProject({ "build.gradle": "plugins {}" });
    expect(processor.getProjectTypes(gradle.project)).toEqual(["gradle"]);
    cleanup(gradle.dir);

    const ant = writeProject({ "build.xml": "<project/>" });
    expect(processor.getProjectTypes(ant.project)).toEqual(["ant"]);
    cleanup(ant.dir);
  });
});
