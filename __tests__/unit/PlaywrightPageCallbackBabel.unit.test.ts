import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as babel from "@babel/core";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

/**
 * A page-side callback must not compile to a reference to a Babel helper.
 *
 * WHY THIS EXISTS
 * ---------------
 * Playwright serialises a function argument and evaluates it INSIDE THE PAGE. Anything the
 * compiled function reaches for at module scope does not exist there. Babel's `for...of`
 * lowering does exactly that:
 *
 *   el.evaluate((node) => {
 *     const out = {};
 *     for (const attr of node.attributes) out[attr.name] = attr.value;
 *     return out;
 *   })
 *
 * compiles, under `bin/build.sh`'s presets, to a body containing
 *
 *   var _iterator = _createForOfIteratorHelper(node.attributes), _step;
 *
 * and `_createForOfIteratorHelper` is a MODULE-level function — invisible to the page. The
 * built image failed at runtime with
 *
 *   locator.evaluate: ReferenceError: _createForOfIteratorHelper is not defined
 *
 * WHY THE RUNTIME SUITE CANNOT CATCH IT
 * ------------------------------------
 * jest's transform runs `@babel/preset-env` with `targets: { node: 'current' }` (see the
 * host's babel.config.js), so `for...of` is never lowered under test. The defect reproduces
 * ONLY under the build's CLI presets, which set no targets. Verified: restoring master's
 * `for…of` callback leaves `PlaywrightBrowserRuntime.browser.test.ts` at 4/4 green.
 *
 * WHY THE IMAGE GATE CANNOT CATCH IT
 * ----------------------------------
 * `scripts/verify/playwright-browser-smoke.js --navigate` does goto → title → screenshot. It
 * never calls `inspectElement`, so the offending callback is never serialised.
 *
 * WHAT THIS TEST DOES INSTEAD
 * ---------------------------
 * It compiles the real service files with the BUILD's presets — `@babel/preset-env` with NO
 * targets, plus preset-typescript and legacy decorators — then walks the compiled AST for
 * call expressions that hand a function to the page:
 *
 *   .evaluate(  $eval(  $$eval(  waitForFunction(  addInitScript(
 *
 * and asserts none of those function arguments reference a Babel helper. It is a static
 * check, so it needs no browser and stays in the `unit` lane.
 *
 * Deliberately NO jest mock of playwright: the compiled output is what is under test.
 */

const traverse: any = (_traverse as any).default ?? _traverse;
const generate: any = (_generate as any).default ?? _generate;

const ROOT = path.resolve(__dirname, "..", "..");

/** Methods whose first argument is serialised and run inside the page. */
const PAGE_SIDE_METHODS = new Set(["evaluate", "$eval", "$$eval", "waitForFunction", "addInitScript"]);

/**
 * Babel helper identifiers that resolve at module scope and therefore must never appear in a
 * page-side callback. `_defineProperty` / `_objectSpread*` are included because object spread
 * in a callback lowers the same way.
 */
const HELPER_REFERENCE =
  /\b_(?:createForOfIteratorHelper|createForOfIteratorHelperLoose|unsupportedIterableToArray|arrayLikeToArray|toConsumableArray|slicedToArray|objectSpread\d*|objectWithoutProperties\d*|defineProperty|asyncToGenerator|regeneratorRuntime)\b/;

/** The presets bin/build.sh applies to ./src: `npx babel ./src --presets @babel/env`. */
const BUILD_BABEL_OPTIONS = {
  babelrc: false,
  configFile: false,
  presets: [
    // NO targets — this is the whole point. A `targets: node current` config (which the host's
    // babel.config.js sets) would not lower for...of and would hide the defect.
    [require("@babel/preset-env"), {}],
    [require("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
  ],
  plugins: [[require("@babel/plugin-proposal-decorators"), { legacy: true }]],
};

/** Files worth compiling: anything that could hand a function to the page. */
function playwrightSources(): string[] {
  const dirs = ["services/playwright", "ai/macro/playwright", "workflow/steps/playwright"];
  const found: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      found.push(path.join(abs, entry));
    }
  }
  return found;
}

interface PageCallback {
  file: string;
  method: string;
  code: string;
  helpers: string[];
}

/** Compile one file with the build presets and collect every page-side callback. */
function pageCallbacksIn(file: string): PageCallback[] {
  const source = fs.readFileSync(file, "utf8");

  // Cheap pre-filter: no page-side call, nothing to compile.
  if (!/\.(?:evaluate|\$eval|\$\$eval|waitForFunction|addInitScript)\s*\(/.test(source)) return [];

  const compiled = babel.transformSync(source, {
    ...BUILD_BABEL_OPTIONS,
    filename: file,
  } as any);
  if (!compiled || typeof compiled.code !== "string") return [];

  const ast = parse(compiled.code, { sourceType: "script", allowReturnOutsideFunction: true });
  const out: PageCallback[] = [];

  traverse(ast, {
    CallExpression(nodePath: any) {
      const callee = nodePath.node.callee;
      if (!callee || callee.type !== "MemberExpression") return;
      const prop = callee.property;
      const name = prop && (prop.name ?? prop.value);
      if (!PAGE_SIDE_METHODS.has(name)) return;

      const first = nodePath.node.arguments[0];
      if (!first) return;
      // Only function literals can be inspected statically. A variable or a string script is
      // resolved at runtime and is out of scope for this check.
      if (
        first.type !== "ArrowFunctionExpression" &&
        first.type !== "FunctionExpression" &&
        first.type !== "ObjectMethod"
      ) {
        return;
      }

      const code = generate(first, { compact: false }).code;
      const helpers = Array.from(
        new Set((code.match(new RegExp(HELPER_REFERENCE.source, "g")) ?? []).map((m) => m.replace(/^_/, ""))),
      );
      out.push({ file: path.relative(ROOT, file), method: name, code, helpers });
    },
  });

  return out;
}

describe("page-side callbacks compile without Babel module-scope helpers", () => {
  const files = playwrightSources();

  it("finds the playwright sources to compile", () => {
    // Guards against the suite silently passing because the glob found nothing.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith("ReactorPlaywrightService.ts"))).toBe(true);
  });

  it("compiles every file with the build's presets", () => {
    // A compile failure here means the preset set has drifted from bin/build.sh.
    for (const file of files) {
      expect(() => pageCallbacksIn(file)).not.toThrow();
    }
  });

  it("collects the callbacks, including the inspectElement attribute reader", () => {
    const callbacks = files.flatMap(pageCallbacksIn);
    // ReactorPlaywrightService alone hands four closures to el.evaluate(); if this drops to
    // zero the traversal has broken and the assertions below would pass vacuously.
    expect(callbacks.length).toBeGreaterThanOrEqual(4);
    expect(callbacks.some((c) => /outerHTML/.test(c.code))).toBe(true);
    expect(callbacks.some((c) => /attributes/.test(c.code))).toBe(true);
  });

  it("no page-side callback references a Babel helper identifier", () => {
    const offenders = files
      .flatMap(pageCallbacksIn)
      .filter((c) => c.helpers.length > 0)
      .map((c) => `${c.file} → .${c.method}(...) references ${c.helpers.join(", ")}\n${c.code}`);

    expect(offenders).toEqual([]);
  });

  it("the helper detector actually fires on a lowered for...of callback", () => {
    // Positive control, so a green run above is evidence rather than a broken regex.
    const control = babel.transformSync(
      "el.evaluate((node) => { const out = {}; for (const a of node.attributes) out[a.name] = a.value; return out; });",
      BUILD_BABEL_OPTIONS as any,
    );
    expect(control?.code).toBeDefined();
    expect(HELPER_REFERENCE.test(control!.code!)).toBe(true);
    expect(control!.code).toContain("_createForOfIteratorHelper");
  });

  it("the helper detector does not fire on the shipped Array.from form", () => {
    // Negative control: the shape this PR uses must stay clean.
    const control = babel.transformSync(
      "el.evaluate((node) => Object.fromEntries(Array.from(node.attributes).map((a) => [a.name, a.value])));",
      BUILD_BABEL_OPTIONS as any,
    );
    expect(HELPER_REFERENCE.test(control!.code!)).toBe(false);
  });
});
