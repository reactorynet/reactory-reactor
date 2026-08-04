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

import path from "path";

export type TreeSitterLanguageId = "java" | "csharp" | "kotlin";

interface LoadResult {
  Parser: any | null;
  Language: any | null;
  error?: string;
}

const languageCache = new Map<TreeSitterLanguageId, LoadResult>();
let parserCtorCache: any | null | undefined;

/** Lazily requires the core `tree-sitter` Parser constructor. Cached. */
const getParserCtor = (): any | null => {
  if (parserCtorCache !== undefined) return parserCtorCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    parserCtorCache = require("tree-sitter");
  } catch {
    parserCtorCache = null;
  }
  return parserCtorCache;
};

const GRAMMAR_MODULE: Record<TreeSitterLanguageId, string> = {
  java: "tree-sitter-java",
  csharp: "tree-sitter-c-sharp",
  kotlin: "@tree-sitter-grammars/tree-sitter-kotlin",
};

/** Lazily requires and caches a grammar's Language object. Never throws. */
const loadLanguage = async (lang: TreeSitterLanguageId): Promise<LoadResult> => {
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
  const hasError = typeof rootNode?.hasError === "function" ? rootNode.hasError() : !!rootNode?.hasError;
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
