import { analyseJavaFile } from "./JavaAnalyzer";
import {
  makeContext,
  writeProject,
  cleanup,
  fileNodeFor,
  symbolId,
  TestProject,
} from "../testUtils";

describe("JavaAnalyzer", () => {
  let dir: string;
  let project: TestProject;
  const ctx = makeContext();

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "Dog.java": `package demo;
import java.util.List;

class Base {
    public String identify() { return "base"; }
}

interface Animal {
    String speak();
}

public class Dog extends Base implements Animal {
    public String speak() { return "woof"; }
    public String describe() { return this.speak() + identify(); }
    public List<String> items() { return null; }
}
`,
    }));
  });

  afterAll(() => cleanup(dir));

  const analyse = () => analyseJavaFile(fileNodeFor(project, "Dog.java", "java"), ctx);

  it("extracts classes, interfaces and methods", () => {
    const a = analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Base", "Animal", "Dog", "speak", "describe", "identify", "items"])
    );
  });

  it("builds INHERITS and IMPLEMENTS edges within the file", () => {
    const a = analyse();
    const dogId = symbolId(project, "Dog.java", "Dog");
    const inherits = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    expect(inherits!.target).toBe(symbolId(project, "Dog.java", "Base"));
    const implementsEdge = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("IMPLEMENTS" as any)
    );
    expect(implementsEdge!.target).toBe(symbolId(project, "Dog.java", "Animal"));
  });

  it("records import dependencies", () => {
    const a = analyse();
    expect(a.externals.map((e) => e.name)).toContain("java.util.List");
    expect(a.edges.some((e) => e.data?.external && e.title === "java.util.List")).toBe(true);
  });

  it("builds CALL edges for this.method invocations", () => {
    const a = analyse();
    const call = a.edges.find(
      (e) =>
        e.source === symbolId(project, "Dog.java", "Dog.describe") &&
        e.types?.includes("CALL" as any)
    );
    expect(call).toBeDefined();
    expect(call!.target).toBe(symbolId(project, "Dog.java", "Dog.speak"));
  });
});
