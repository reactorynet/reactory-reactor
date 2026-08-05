import path from "path";
import {
  isTreeSitterAvailable,
  parseSource,
  parseWithTreeSitter,
  TreeSitterLanguageId,
} from "./TreeSitterEngine";

/**
 * Guards the process-wide invariant that makes the tree-sitter analyzers work
 * at all: the core `tree-sitter` JS wrapper must be evaluated exactly once per
 * process.
 *
 * The wrapper replaces the native `Tree.prototype.rootNode` method with an
 * accessor, having first captured the original by destructuring. A second
 * evaluation destructures the *accessor* (invoked with `this ===
 * Tree.prototype`, which fails its `this instanceof Tree` guard and yields
 * `undefined`) and closes over that `undefined`, so `tree.rootNode` is
 * `undefined` for the remainder of the process.
 *
 * Under Jest that meant the first analyzer suite to load a grammar passed and
 * every later one failed with "Cannot read properties of undefined (reading
 * 'namedChildren')". These tests fail if the caching that prevents it is lost.
 */

const SAMPLES: Record<TreeSitterLanguageId, { source: string; rootType: string }> = {
  java: { source: "class Sample { void run() {} }", rootType: "program" },
  csharp: { source: "class Sample { void Run() {} }", rootType: "compilation_unit" },
  kotlin: { source: "class Sample { fun run() {} }", rootType: "source_file" },
};

const LANGUAGES = Object.keys(SAMPLES) as TreeSitterLanguageId[];

describe("TreeSitterEngine", () => {
  it.each(LANGUAGES)("parses %s into a usable rootNode", async (lang) => {
    if (!(await isTreeSitterAvailable(lang))) {
      // A missing grammar is a valid environment, not a failure - the analyzers
      // fall back to their heuristic engines.
      return;
    }
    const { rootNode } = await parseSource(lang, SAMPLES[lang].source);
    expect(rootNode).toBeDefined();
    expect(rootNode.type).toBe(SAMPLES[lang].rootType);
    // namedChildren is what every analyzer walks first; it was the symptom.
    expect(Array.isArray(rootNode.namedChildren)).toBe(true);
    expect(rootNode.namedChildren.length).toBeGreaterThan(0);
  });

  it("keeps rootNode usable across every grammar in one process", async () => {
    // Loading a second and third grammar must not disturb the first. This is
    // the cross-suite interference reproduced inside a single test file.
    const available: TreeSitterLanguageId[] = [];
    for (const lang of LANGUAGES) {
      if (await isTreeSitterAvailable(lang)) available.push(lang);
    }
    if (available.length < 2) return;

    for (const lang of available) {
      const { rootNode } = await parseSource(lang, SAMPLES[lang].source);
      expect(rootNode?.type).toBe(SAMPLES[lang].rootType);
    }
    // Re-parse the first grammar last: if a later load clobbered the shared
    // prototype, this is where it shows.
    const first = available[0];
    const { rootNode } = await parseSource(first, SAMPLES[first].source);
    expect(rootNode?.namedChildren?.length).toBeGreaterThan(0);
  });

  it("caches the core wrapper on the shared native binding, not per registry", () => {
    // globalThis and process are fresh per Jest test file, so the cache has to
    // live on the one object Node caches per *process*: the native addon.
    let binding: any;
    try {
      const coreDir = path.dirname(require.resolve("tree-sitter/package.json"));
      binding = require("node-gyp-build")(coreDir);
    } catch {
      return; // tree-sitter not installed in this environment
    }
    // Populated by the parses above, via the engine.
    const cache = binding.__reactoryTreeSitterShared;
    expect(cache).toBeDefined();
    expect(cache.parserCtor).toBeTruthy();
    expect(cache.languages).toBeInstanceOf(Map);
  });

  it("reports a clear diagnostic instead of a null rootNode", async () => {
    if (!(await isTreeSitterAvailable("java"))) return;
    // parseSource must never hand back { rootNode: undefined } - that is what
    // surfaced as an opaque TypeError deep inside an analyzer.
    const tree = await parseWithTreeSitter("java", SAMPLES.java.source);
    expect(tree).not.toBeNull();
    expect(tree.rootNode).toBeDefined();
    await expect(parseSource("java", SAMPLES.java.source)).resolves.toMatchObject({
      hasError: false,
    });
  });
});
