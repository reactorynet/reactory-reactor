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

  it("extracts classes, interfaces and methods across a namespace", () => {
    const a = analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Base", "IAnimal", "Dog", "Speak", "Describe", "Identify"])
    );
  });

  it("classifies base class vs interface via the IXxx convention", () => {
    const a = analyse();
    const dogId = symbolId(project, "Dog.cs", "Dog");
    const inherits = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    expect(inherits!.target).toBe(symbolId(project, "Dog.cs", "Base"));
    const impl = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("IMPLEMENTS" as any)
    );
    expect(impl!.target).toBe(symbolId(project, "Dog.cs", "IAnimal"));
  });

  it("records using dependencies", () => {
    const a = analyse();
    expect(a.externals.map((e) => e.name)).toEqual(
      expect.arrayContaining(["System", "System.Collections.Generic"])
    );
  });

  it("builds CALL edges for this.method invocations", () => {
    const a = analyse();
    const call = a.edges.find(
      (e) =>
        e.source === symbolId(project, "Dog.cs", "Dog.Describe") &&
        e.types?.includes("CALL" as any)
    );
    expect(call).toBeDefined();
    expect(call!.target).toBe(symbolId(project, "Dog.cs", "Dog.Speak"));
  });
});
