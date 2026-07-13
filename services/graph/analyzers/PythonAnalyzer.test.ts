import { analysePythonFile } from "./PythonAnalyzer";
import {
  makeContext,
  writeProject,
  cleanup,
  fileNodeFor,
  symbolId,
  fileId,
  TestProject,
} from "../testUtils";

describe("PythonAnalyzer", () => {
  let dir: string;
  let project: TestProject;
  const ctx = makeContext();

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "app/models.py": `class Base:
    def identify(self):
        return 'base'


class Animal:
    def speak(self):
        return '...'
`,
      "app/service.py": `from .models import Base, Animal
import os
from collections import OrderedDict


class Dog(Base, Animal):
    def speak(self):
        return 'woof'

    def describe(self):
        return self.speak() + self.identify()


def make_dog():
    d = Dog()
    return d.speak()
`,
    }));
  });

  afterAll(() => cleanup(dir));

  const analyse = () => analysePythonFile(fileNodeFor(project, "app/service.py", "python"), ctx);

  it("extracts classes, methods and functions with qualifiers", () => {
    const a = analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Dog", "speak", "describe", "make_dog"]));
    const describe = a.symbols.find((s) => s.name === "describe")!;
    expect(describe.data.symbolPath).toBe("Dog.describe");
  });

  it("resolves imports: relative file edge + external packages", () => {
    const a = analyse();
    const modelsFile = fileId(project, "app/models.py");
    const fileEdge = a.edges.find((e) => e.target === modelsFile);
    expect(fileEdge).toBeDefined();
    expect(fileEdge!.types).toContain("DEPENDENCY");
    expect(a.externals.map((e) => e.name)).toEqual(
      expect.arrayContaining(["os", "collections"])
    );
  });

  it("builds INHERITS edges resolved across files via import bindings", () => {
    const a = analyse();
    const dogId = symbolId(project, "app/service.py", "Dog");
    const inherits = a.edges.filter(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    const targets = inherits.map((e) => e.target);
    expect(targets).toContain(symbolId(project, "app/models.py", "Base"));
    expect(targets).toContain(symbolId(project, "app/models.py", "Animal"));
  });

  it("builds CALL edges for self.method and construction", () => {
    const a = analyse();
    const calls = a.edges.filter((e) => e.types?.includes("CALL" as any));

    const selfCall = calls.find(
      (e) => e.source === symbolId(project, "app/service.py", "Dog.describe")
    );
    expect(selfCall).toBeDefined();
    expect(selfCall!.target).toBe(symbolId(project, "app/service.py", "Dog.speak"));

    const ctorCall = calls.find(
      (e) => e.source === symbolId(project, "app/service.py", "make_dog")
    );
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.target).toBe(symbolId(project, "app/service.py", "Dog"));
  });
});
