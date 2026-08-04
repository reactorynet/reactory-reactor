import { analyseKotlinFile } from "./KotlinAnalyzer";
import {
  makeContext,
  writeProject,
  cleanup,
  fileNodeFor,
  symbolId,
  TestProject,
} from "../testUtils";

describe("KotlinAnalyzer", () => {
  let dir: string;
  let project: TestProject;
  const ctx = makeContext();

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "Dog.kt": `package demo

import kotlin.collections.List

interface Animal {
    fun speak(): String
}

open class Base {
    fun identify(): String = "base"
}

class Dog : Base(), Animal {
    override fun speak(): String {
        return "woof"
    }
    fun describe(): String {
        return this.speak() + identify()
    }
}
`,
    }));
  });

  afterAll(() => cleanup(dir));

  const analyse = () => analyseKotlinFile(fileNodeFor(project, "Dog.kt", "kotlin"), ctx);

  it("extracts classes, interfaces and functions", async () => {
    const a = await analyse();
    const names = a.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Animal", "Base", "Dog", "speak", "identify", "describe"])
    );
  });

  it("distinguishes extends-class (constructor_invocation) from implements-interface (bare user_type) via real grammar, not a heuristic", async () => {
    const a = await analyse();
    const dogId = symbolId(project, "Dog.kt", "Dog");
    const inherits = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("INHERITS" as any)
    );
    expect(inherits!.target).toBe(symbolId(project, "Dog.kt", "Base"));
    const implementsEdge = a.edges.find(
      (e) => e.source === dogId && e.types?.includes("IMPLEMENTS" as any)
    );
    expect(implementsEdge!.target).toBe(symbolId(project, "Dog.kt", "Animal"));
  });

  it("records import dependencies", async () => {
    const a = await analyse();
    expect(a.externals.map((e) => e.name)).toContain("kotlin.collections.List");
  });

  it("builds CALL edges for this.method invocations", async () => {
    const a = await analyse();
    const call = a.edges.find(
      (e) =>
        e.source === symbolId(project, "Dog.kt", "Dog.describe") &&
        e.types?.includes("CALL" as any)
    );
    expect(call).toBeDefined();
    expect(call!.target).toBe(symbolId(project, "Dog.kt", "Dog.speak"));
  });

  it("gives a data class its own primary constructor symbol", async () => {
    const { dir: dir2, project: p2 } = writeProject({
      "Point.kt": `data class Point(val x: Int, val y: Int) {
    fun length(): Int {
        return x + y
    }
}
`,
    });
    try {
      const result = await analyseKotlinFile(fileNodeFor(p2, "Point.kt", "kotlin"), ctx);
      expect(
        result.symbols.some((s) => s.name === "constructor" && s.data?.symbolKind === "constructor")
      ).toBe(true);
      expect(result.symbols.some((s) => s.name === "Point" && s.data?.symbolKind === "class")).toBe(
        true
      );
    } finally {
      cleanup(dir2);
    }
  });

  it("handles sealed class hierarchies with nested data class / object members", async () => {
    const { dir: dir2, project: p2 } = writeProject({
      "Result.kt": `sealed class Result {
    data class Success(val value: String) : Result()
    object Failure : Result()
}
`,
    });
    try {
      const result = await analyseKotlinFile(fileNodeFor(p2, "Result.kt", "kotlin"), ctx);
      const names = result.symbols.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(["Result", "Success", "Failure"]));
      const successId = symbolId(p2, "Result.kt", "Result.Success");
      const inherits = result.edges.find(
        (e) => e.source === successId && e.types?.includes("INHERITS" as any)
      );
      expect(inherits).toBeDefined();
      expect(inherits!.target).toBe(symbolId(p2, "Result.kt", "Result"));
    } finally {
      cleanup(dir2);
    }
  });

  it("builds a CALL edge for bare `Foo()` construction resolved against a locally-known type (Kotlin has no `new` keyword)", async () => {
    const { dir: dir2, project: p2 } = writeProject({
      "Widget.kt": `class Helper {
    fun assist() {}
}

class Widget {
    fun run() {
        val h = Helper()
        h.assist()
    }
}
`,
    });
    try {
      const result = await analyseKotlinFile(fileNodeFor(p2, "Widget.kt", "kotlin"), ctx);
      const construction = result.edges.find(
        (e) =>
          e.source === symbolId(p2, "Widget.kt", "Widget.run") &&
          e.title === "Helper" &&
          e.types?.includes("CALL" as any)
      );
      expect(construction).toBeDefined();
    } finally {
      cleanup(dir2);
    }
  });
});
