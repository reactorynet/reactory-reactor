/**
 * Lazy, safe loader for tree-sitter core + per-language grammars.
 *
 * Each grammar package pins a different (optional) peer version of the core
 * `tree-sitter` package (java ^0.21.1, kotlin ^0.22.4, c-sharp ^0.25.0). The
 * core JS Parser API (`new Parser()`, `setLanguage`, `parse`) has been stable
 * across these minor versions, so a single installed core version works with
 * all three native grammar bindings.
 *
 * If a grammar (or tree-sitter itself) is not installed / fails to load in a
 * given runtime environment, `getLanguage` returns `null` rather than
 * throwing — callers are expected to fall back to a heuristic analyzer
 * (see JavaAnalyzer.ts / CSharpAnalyzer.ts, which fall back to the original
 * regex/brace engine in `./legacyRegex`).
 */

import fs from "fs";
import path from "path";

export type TreeSitterLanguageId = "java" | "csharp" | "kotlin" | "python";

interface LoadResult {
  Parser: any | null;
  Language: any | null;
  error?: string;
}

/**
 * The `tree-sitter` JS wrapper may only be **evaluated once per process**, and
 * its own source says so:
 *
 *     const {rootNode, rootNodeWithOffset, edit} = Tree.prototype;
 *     Object.defineProperty(Tree.prototype, 'rootNode', { get() { ... } });
 *
 * `Tree` comes from the native addon, which Node caches per *process*, so
 * `Tree.prototype` is shared by every module registry. The first evaluation
 * replaces the native `rootNode` method with an accessor. A second evaluation
 * destructures `Tree.prototype.rootNode` again — now invoking that accessor
 * with `this === Tree.prototype`, which fails its `this instanceof Tree` guard
 * and yields `undefined`. The re-installed getter closes over that `undefined`,
 * so from then on **`tree.rootNode` is `undefined` for the rest of the
 * process** (and `rootNodeWithOffset`/`walk()` degrade the same way, one
 * generation behind).
 *
 * Under Jest that is exactly what happens: every test file gets a fresh module
 * registry — and a fresh `globalThis` and `process`, so no JS-level cache can
 * span them — while the native addon stays shared. The first suite to load a
 * grammar worked and every later one saw `rootNode === undefined`, which
 * surfaced as `Cannot read properties of undefined (reading 'namedChildren')`.
 *
 * The fix is to evaluate the wrapper once and share the result through the one
 * object that *is* process-global: the native binding itself. Registries after
 * the first find the cached constructor and never re-require the wrapper, so
 * the prototypes it set up stay intact.
 */
const SHARED_CACHE_KEY = "__reactoryTreeSitterShared";

interface SharedCache {
  /** `undefined` = not attempted, `null` = unavailable. */
  parserCtor?: any | null;
  languages: Map<TreeSitterLanguageId, LoadResult>;
}

/**
 * The core addon's exports object. Node caches native modules per process, so
 * this is the same object in every module registry — unlike `globalThis`.
 * Requiring it does not evaluate the `tree-sitter` JS wrapper, so it is safe to
 * call before deciding whether the wrapper still needs loading.
 */
const nativeBinding = (): any | null => {
  try {
    const coreDir = path.dirname(require.resolve("tree-sitter/package.json"));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node-gyp-build")(coreDir);
  } catch {
    return null;
  }
};

const sharedCache = (): SharedCache => {
  // Falls back to module scope when the addon cannot be loaded at all; there is
  // nothing to protect in that case.
  const host = nativeBinding() || (globalThis as Record<string, any>);
  if (!host[SHARED_CACHE_KEY]) {
    host[SHARED_CACHE_KEY] = { languages: new Map() } as SharedCache;
  }
  return host[SHARED_CACHE_KEY] as SharedCache;
};

/**
 * Requires the core `tree-sitter` Parser constructor, at most once per process.
 * See SHARED_CACHE_KEY above for why re-requiring it must be avoided.
 */
const getParserCtor = (): any | null => {
  const cache = sharedCache();
  if (cache.parserCtor !== undefined) return cache.parserCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cache.parserCtor = require("tree-sitter");
  } catch {
    cache.parserCtor = null;
  }
  return cache.parserCtor;
};

const GRAMMAR_MODULE: Record<TreeSitterLanguageId, string> = {
  java: "tree-sitter-java",
  csharp: "tree-sitter-c-sharp",
  kotlin: "@tree-sitter-grammars/tree-sitter-kotlin",
  python: "tree-sitter-python",
};

/**
 * Lazily requires and caches a grammar's Language object. Never throws.
 * Cached on the shared (process-global) cache alongside the Parser ctor, so a
 * grammar's native addon is resolved once no matter how many module registries
 * ask for it.
 */
const loadLanguage = async (lang: TreeSitterLanguageId): Promise<LoadResult> => {
  const languageCache = sharedCache().languages;
  const cached = languageCache.get(lang);
  if (cached && cached.Language) return cached;

  const ParserCtor = getParserCtor();
  if (!ParserCtor) {
    const result: LoadResult = { Parser: null, Language: null, error: "tree-sitter core not installed" };
    languageCache.set(lang, result);
    return result;
  }

  try {
    let grammar: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      grammar = require(GRAMMAR_MODULE[lang]);
    } catch {
      try {
        // Direct prebuild .node require (for ESM-wrapped packages like tree-sitter-c-sharp in CJS runtimes)
        const pkgDir = path.dirname(require.resolve(`${GRAMMAR_MODULE[lang]}/package.json`));
        const nativeBinding = path.join(
          pkgDir,
          "prebuilds",
          `${process.platform}-${process.arch}`,
          `${GRAMMAR_MODULE[lang]}.node`
        );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        grammar = require(nativeBinding);
      } catch {
        try {
          const pkgDir = path.dirname(require.resolve(`${GRAMMAR_MODULE[lang]}/package.json`));
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          grammar = require("node-gyp-build")(pkgDir);
        } catch {
          const dynamicImport = new Function("modulePath", "return import(modulePath)");
          grammar = await dynamicImport(GRAMMAR_MODULE[lang]);
        }
      }
    }
    // Grammar packages export either the Language object directly, or
    // { language: Language }, or { default: Language }, or (some builds like c_sharp) named export or function
    let Language: any;
    if (typeof grammar === "function") {
      try {
        Language = grammar();
      } catch {
        Language = grammar;
      }
    } else if (grammar && typeof grammar.c_sharp === "function") {
      Language = grammar.c_sharp();
    } else if (grammar && grammar.c_sharp) {
      Language = grammar.c_sharp;
    } else if (grammar && typeof grammar.python === "function") {
      Language = grammar.python();
    } else if (grammar && grammar.python) {
      Language = grammar.python;
    } else if (grammar && grammar.default) {
      Language = grammar.default;
    } else {
      Language = grammar;
    }

    if (Language && !Language.nodeTypeInfo) {
      try {
        const pkgDir = path.dirname(require.resolve(`${GRAMMAR_MODULE[lang]}/package.json`));
        const nodeTypesPath = path.join(pkgDir, "src", "node-types.json");
        if (fs.existsSync(nodeTypesPath)) {
          Language.nodeTypeInfo = JSON.parse(fs.readFileSync(nodeTypesPath, "utf-8"));
        }
      } catch {
        // ignore
      }
    }

    const result: LoadResult = { Parser: ParserCtor, Language };
    if (Language) {
      languageCache.set(lang, result);
    }
    return result;
  } catch (err) {
    const result: LoadResult = {
      Parser: ParserCtor,
      Language: null,
      error: `failed to load ${GRAMMAR_MODULE[lang]}: ${(err as Error).message}`,
    };
    languageCache.set(lang, result);
    return result;
  }
};

/** True when the given language's grammar is installed and loadable. */
export const isTreeSitterAvailable = async (lang: TreeSitterLanguageId): Promise<boolean> => {
  const { Parser, Language } = await loadLanguage(lang);
  return !!Parser && !!Language;
};

/**
 * Parses `source` with the given language's grammar. Returns `null` if the
 * grammar/core is unavailable or parsing throws — callers must treat `null`
 * as "fall back to the heuristic analyzer", never as an empty-file signal.
 */
export const parseWithTreeSitter = async (lang: TreeSitterLanguageId, source: string): Promise<any | null> => {
  const { Parser, Language, error } = await loadLanguage(lang);
  if (error) {
    console.error(`loadLanguage failed for ${lang}: ${error}`);
  }
  if (!Parser || !Language) return null;
  try {
    const parser = new Parser();
    parser.setLanguage(Language);
    return parser.parse(source);
  } catch (err) {
    console.error(`parseWithTreeSitter setLanguage/parse error for ${lang}:`, err);
    return null;
  }
};

/** Diagnostic helper — returns the load error (if any) for a language. */
export const treeSitterLoadError = async (lang: TreeSitterLanguageId): Promise<string | undefined> =>
  (await loadLanguage(lang)).error;

/**
 * Parses source code into a TreeSitter rootNode and hasError flag.
 *
 * A parsed tree with no `rootNode` means the core wrapper's prototype patching
 * has been clobbered by a second evaluation (see SHARED_CACHE_KEY). That is a
 * process-wide fault, not a problem with this file, so it is reported as such —
 * otherwise it surfaces far away as "Cannot read properties of undefined
 * (reading 'namedChildren')" inside whichever analyzer asked first.
 */
export const parseSource = async (
  lang: TreeSitterLanguageId,
  source: string
): Promise<{ rootNode: any; hasError: boolean }> => {
  const tree = await parseWithTreeSitter(lang, source);
  if (!tree) {
    const err = (await treeSitterLoadError(lang)) || "unknown error";
    throw new Error(`TreeSitter parser unavailable for language ${lang}: ${err}`);
  }
  const rootNode = tree.rootNode;
  if (!rootNode) {
    throw new Error(
      `TreeSitter returned a tree with no rootNode for language ${lang}. The ` +
        `core 'tree-sitter' JS wrapper has been evaluated more than once in this ` +
        `process, which permanently breaks Tree.prototype.rootNode. Load it only ` +
        `through TreeSitterEngine, which caches it on the shared native binding.`
    );
  }
  const hasError = typeof rootNode.hasError === "function" ? rootNode.hasError() : !!rootNode.hasError;
  return { rootNode, hasError };
};

/**
 * Returns 1-based line number for a TreeSitter syntax node.
 */
export const lineOf = (node: any): number => {
  if (!node || !node.startPosition) return 1;
  return node.startPosition.row + 1;
};

/**
 * Returns named children matching any of the given type strings.
 */
export const namedChildrenOfType = (node: any, types: string[]): any[] => {
  if (!node || !node.namedChildren) return [];
  return node.namedChildren.filter((c: any) => types.includes(c.type));
};

/**
 * Recursively collects descendant AST nodes matching `targetTypes`,
 * stopping recursion at any node matching `stopTypes`.
 */
export const collectDescendants = (
  node: any,
  targetTypes: string[],
  stopTypes: string[] = []
): any[] => {
  if (!node) return [];
  const results: any[] = [];
  const visit = (n: any) => {
    if (!n) return;
    const children = n.children || n.namedChildren || [];
    for (const child of children) {
      if (targetTypes.includes(child.type)) {
        results.push(child);
      }
      if (!stopTypes.includes(child.type)) {
        visit(child);
      }
    }
  };
  visit(node);
  return results;
};

/**
 * Cleans generic parameters or array brackets from a type name string.
 * e.g. "List<String>" -> "List"
 */
export const cleanTypeName = (typeName: string): string => {
  if (!typeName) return "";
  return typeName.split("<")[0].split("[")[0].trim();
};
