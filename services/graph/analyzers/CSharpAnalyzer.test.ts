import { analyseCSharpFile } from "./CSharpAnalyzer";
import {
  makeContext,
  writeProject,
  cleanup,
  fileNodeFor,
  symbolId,
  TestProject,
} from "../testUtils";

describe("CSharpAnalyzer", () => {
  let dir: string;
  let project: TestProject;
  const ctx = makeContext();

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "Dog.cs": `using System;
using System.Collections.Generic;

namespace Demo {
    public class Base {
        public string Identify() { return "base"; }
    }

    public interface IAnimal {
        string Speak();
    }

    public class Dog : Base, IAnimal {
        public string Speak() { return "woof"; }
        public string Describe() { return this.Speak(); }
    }
}
`,
    }));
  });

  afterAll(() => cleanup(dir));

  const analyse = () => analyseCSharpFile(fileNodeFor(project, "Dog.cs", "csharp"), ctx);

  it("extracts classes, interfaces and methods across a namespace", async () => {
    const a = await analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Base", "IAnimal", "Dog", "Speak", "Describe", "Identify"])
    );
  });

  it("classifies base class vs interface from real AST node kinds (Phase 0 fix - no longer a naming guess for same-file types)", async () => {
    const a = await analyse();
    const dogId = symbolId(project, "Dog.cs", "Dog");
    const inherits = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    expect(inherits!.target).toBe(symbolId(project, "Dog.cs", "Base"));
    expect(inherits!.data?.resolved).toBe(true);
    const impl = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("IMPLEMENTS" as any)
    );
    expect(impl!.target).toBe(symbolId(project, "Dog.cs", "IAnimal"));
    expect(impl!.data?.resolved).toBe(true);
  });

  it("classifies an interface NOT following the IXxx convention correctly (proves the naming heuristic is retired for local types)", async () => {
    const { dir, project: p2 } = writeProject({
      "Shape.cs": `namespace Demo {
    public interface Describable {
        string Describe();
    }
    public class Circle : Describable {
        public string Describe() { return "circle"; }
    }
}
`,
    });
    try {
      const result = await analyseCSharpFile(fileNodeFor(p2, "Shape.cs", "csharp"), ctx);
      const circleId = symbolId(p2, "Shape.cs", "Circle");
      const impl = result.edges.find(
        (e) => e.source === circleId && e.types?.includes("IMPLEMENTS" as any)
      );
      expect(impl).toBeDefined();
      expect(impl!.target).toBe(symbolId(p2, "Shape.cs", "Describable"));
      expect(impl!.data?.resolved).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("classifies a struct's base list as IMPLEMENTS-only by C# language rule", async () => {
    const { dir, project: p2 } = writeProject({
      "Point.cs": `namespace Demo {
    public interface ILocatable {
        int X { get; }
    }
    public struct Point : ILocatable {
        public int X => 0;
    }
}
`,
    });
    try {
      const result = await analyseCSharpFile(fileNodeFor(p2, "Point.cs", "csharp"), ctx);
      const pointId = symbolId(p2, "Point.cs", "Point");
      const impl = result.edges.find(
        (e) => e.source === pointId && e.types?.includes("IMPLEMENTS" as any)
      );
      expect(impl).toBeDefined();
      expect(impl!.target).toBe(symbolId(p2, "Point.cs", "ILocatable"));
    } finally {
      cleanup(dir);
    }
  });

  it("records using dependencies", async () => {
    const a = await analyse();
    expect(a.externals.map((e) => e.name)).toEqual(
      expect.arrayContaining(["System", "System.Collections.Generic"])
    );
  });

  it("builds CALL edges for this.method invocations", async () => {
    const a = await analyse();
    const call = a.edges.find(
      (e) =>
        e.source === symbolId(project, "Dog.cs", "Dog.Describe") &&
        e.types?.includes("CALL" as any)
    );
    expect(call).toBeDefined();
    expect(call!.target).toBe(symbolId(project, "Dog.cs", "Dog.Speak"));
  });

  it("builds a CALL edge for `new X()` construction (Phase 0 fix - previously impossible)", async () => {
    const { dir, project: p2 } = writeProject({
      "Widget.cs": `namespace Demo {
    public class Helper {
        public Helper() {}
        public void Assist() {}
    }
    public class Widget {
        public void Run() {
            var h = new Helper();
            h.Assist();
        }
    }
}
`,
    });
    try {
      const result = await analyseCSharpFile(fileNodeFor(p2, "Widget.cs", "csharp"), ctx);
      expect(
        result.symbols.some((s) => s.name === "Helper" && s.data?.symbolKind === "constructor")
      ).toBe(true);
      const construction = result.edges.find(
        (e) =>
          e.source === symbolId(p2, "Widget.cs", "Widget.Run") &&
          e.title === "new Helper" &&
          e.types?.includes("CALL" as any)
      );
      expect(construction).toBeDefined();
      expect(construction!.target).toBe(symbolId(p2, "Widget.cs", "Helper.Helper"));
    } finally {
      cleanup(dir);
    }
  });
});
