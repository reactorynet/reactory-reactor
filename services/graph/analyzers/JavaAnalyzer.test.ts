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

  it("extracts classes, interfaces and methods", async () => {
    const a = await analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Base", "Animal", "Dog", "speak", "describe", "identify", "items"])
    );
  });

  it("builds INHERITS and IMPLEMENTS edges within the file", async () => {
    const a = await analyse();
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

  it("records import dependencies", async () => {
    const a = await analyse();
    expect(a.externals.map((e) => e.name)).toContain("java.util.List");
    expect(a.edges.some((e) => e.data?.external && e.title === "java.util.List")).toBe(true);
  });

  it("builds CALL edges for this.method invocations", async () => {
    const a = await analyse();
    const call = a.edges.find(
      (e) =>
        e.source === symbolId(project, "Dog.java", "Dog.describe") &&
        e.types?.includes("CALL" as any)
    );
    expect(call).toBeDefined();
    expect(call!.target).toBe(symbolId(project, "Dog.java", "Dog.speak"));
  });

  it("extracts constructors as real symbols (Phase 0 fix - previously excluded)", async () => {
    const a = await analyse();
    expect(a.symbols.some((s) => s.name === "Dog" && s.data?.symbolKind === "constructor")).toBe(
      false // Dog has no explicit constructor in this fixture; see construction test below
    );
  });

  it("builds a CALL edge for `new X()` construction (Phase 0 fix - previously impossible)", async () => {
    const { dir, project: p2 } = writeProject({
      "Widget.java": `package demo;

class Helper {
    public Helper() {}
    public void assist() {}
}

public class Widget {
    public void run() {
        Helper h = new Helper();
        h.assist();
    }
}
`,
    });
    try {
      const result = await analyseJavaFile(fileNodeFor(p2, "Widget.java", "java"), ctx);
      expect(
        result.symbols.some((s) => s.name === "Helper" && s.data?.symbolKind === "constructor")
      ).toBe(true);
      const construction = result.edges.find(
        (e) =>
          e.source === symbolId(p2, "Widget.java", "Widget.run") &&
          e.title === "new Helper" &&
          e.types?.includes("CALL" as any)
      );
      expect(construction).toBeDefined();
      expect(construction!.target).toBe(symbolId(p2, "Widget.java", "Helper.Helper"));
    } finally {
      cleanup(dir);
    }
  });
});
