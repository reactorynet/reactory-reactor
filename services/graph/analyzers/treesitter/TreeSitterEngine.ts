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
const loadLanguage = (lang: TreeSitterLanguageId): LoadResult => {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const ParserCtor = getParserCtor();
  if (!ParserCtor) {
    const result: LoadResult = { Parser: null, Language: null, error: "tree-sitter core not installed" };
    languageCache.set(lang, result);
    return result;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const grammar = require(GRAMMAR_MODULE[lang]);
    // Grammar packages export either the Language object directly, or
    // { default: Language }, or (some builds) named export matching the
    // language id — normalise defensively.
    const Language = grammar?.default || grammar;
    const result: LoadResult = { Parser: ParserCtor, Language };
    languageCache.set(lang, result);
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
export const isTreeSitterAvailable = (lang: TreeSitterLanguageId): boolean => {
  const { Parser, Language } = loadLanguage(lang);
  return !!Parser && !!Language;
};

/**
 * Parses `source` with the given language's grammar. Returns `null` if the
 * grammar/core is unavailable or parsing throws — callers must treat `null`
 * as "fall back to the heuristic analyzer", never as an empty-file signal.
 */
export const parseWithTreeSitter = (lang: TreeSitterLanguageId, source: string): any | null => {
  const { Parser, Language } = loadLanguage(lang);
  if (!Parser || !Language) return null;
  try {
    const parser = new Parser();
    parser.setLanguage(Language);
    return parser.parse(source);
  } catch {
    return null;
  }
};

/** Diagnostic helper — returns the load error (if any) for a language. */
export const treeSitterLoadError = (lang: TreeSitterLanguageId): string | undefined =>
  loadLanguage(lang).error;
