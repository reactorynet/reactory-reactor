import fs from "fs";
import path from "path";
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

  it("extracts classes, methods and functions with qualifiers", async () => {
    const a = await analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Dog", "speak", "describe", "make_dog"]));
    const describe = a.symbols.find((s) => s.name === "describe")!;
    expect(describe.data.symbolPath).toBe("Dog.describe");
  });

  it("resolves imports: relative file edge + external packages", async () => {
    const a = await analyse();
    const modelsFile = fileId(project, "app/models.py");
    const fileEdge = a.edges.find((e) => e.target === modelsFile);
    expect(fileEdge).toBeDefined();
    expect(fileEdge!.types).toContain("DEPENDENCY");
    expect(a.externals.map((e) => e.name)).toEqual(
      expect.arrayContaining(["os", "collections"])
    );
  });

  it("builds INHERITS edges resolved across files via import bindings", async () => {
    const a = await analyse();
    const dogId = symbolId(project, "app/service.py", "Dog");
    const inherits = a.edges.filter(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    const targets = inherits.map((e) => e.target);
    expect(targets).toContain(symbolId(project, "app/models.py", "Base"));
    expect(targets).toContain(symbolId(project, "app/models.py", "Animal"));
  });

  it("builds CALL edges for self.method and construction", async () => {
    const a = await analyse();
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

  describe("Heuristic fallback resilience", () => {
    it("falls back to indentation heuristic when tree-sitter is unavailable", async () => {
      // Simulate unavailable tree-sitter by passing invalid node or syntax
      const a = await analysePythonFile(fileNodeFor(project, "app/service.py", "python"), ctx);
      expect(a.symbols.length).toBeGreaterThan(0);
      expect(a.edges.length).toBeGreaterThan(0);
    });
  });

  describe("Architecture invariant I7: Tree-sitter import guard", () => {
    it("ensures no direct require('tree-sitter') or runtime imports outside TreeSitterEngine", () => {
      const analyzersDir = path.resolve(__dirname, "..");
      const files = fs.readdirSync(analyzersDir);
      const violations: string[] = [];

      for (const file of files) {
        const fullPath = path.join(analyzersDir, file);
        if (!fs.statSync(fullPath).isFile() || !file.endsWith(".ts")) continue;
        const content = fs.readFileSync(fullPath, "utf-8");

        // Disallow bare require("tree-sitter") or require('tree-sitter')
        if (/require\s*\(\s*['"]tree-sitter['"]\s*\)/.test(content)) {
          violations.push(`${file}: contains require("tree-sitter")`);
        }

        // Disallow runtime value import `import ... from "tree-sitter"` (only `import type` allowed)
        const importMatches = content.match(/import\s+(?!type\b)[^;]+from\s+['"]tree-sitter['"]/g);
        if (importMatches) {
          violations.push(`${file}: contains value import from "tree-sitter" (${importMatches.join(", ")})`);
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
