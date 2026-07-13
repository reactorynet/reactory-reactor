import CSharpProjectProcessor from "./CSharpProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";

describe("CSharpProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new CSharpProjectProcessor({}, ctx);

  it("instantiates", () => {
    expect(processor).toBeDefined();
  });

  it("returns false when no repoPath", () => {
    expect(processor.supportsProject({})).toBe(false);
  });

  it("detects .csproj / .sln projects and rejects foreign ones", () => {
    const proj = writeProject({ "App.csproj": "<Project/>", "Program.cs": "class P {}" });
    expect(processor.supportsProject(proj.project)).toBe(true);
    expect(processor.getProjectTypes(proj.project)).toEqual(["csharp"]);
    cleanup(proj.dir);

    const sln = writeProject({ "App.sln": "Microsoft Visual Studio Solution File" });
    expect(processor.supportsProject(sln.project)).toBe(true);
    cleanup(sln.dir);

    const foreign = writeProject({ "index.js": "module.exports = 1;" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    cleanup(foreign.dir);
  });
});
