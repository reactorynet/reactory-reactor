/**
 * The document analysis model.
 *
 * Parsing a document is deliberately separated from graphing it:
 *
 *   content --(parser)--> DocumentOutline --(DocumentGraphEmitter)--> nodes/edges
 *
 * A parser knows one dialect (markdown, plain text, ...) and produces a
 * dialect-agnostic `DocumentOutline`. The emitter knows nothing about markdown
 * and turns any outline into deterministic graph nodes and edges. Adding a new
 * dialect therefore means adding a parser only.
 */

/** Document dialects with a parser. */
export type DocumentFormat =
  | "markdown"
  | "mdx"
  | "asciidoc"
  | "restructuredtext"
  | "text";

/**
 * A heading-delimited section of a document.
 *
 * `slug` is the document-unique anchor (GitHub-compatible for markdown). It is
 * the section's identity: a cross-document link such as
 * `docs/guide.md#installing` resolves to the section whose slug is
 * `installing`, without the linking document having to know the target's
 * heading hierarchy. Nesting is expressed by `parentIndex`, not by the slug.
 */
export interface DocSection {
  /** Heading text with inline markup stripped. */
  title: string;
  /** 1 (h1) .. 6 (h6). */
  level: number;
  /** Document-unique anchor slug. */
  slug: string;
  /** 1-based line of the heading itself. */
  line: number;
  /** 1-based line of the last line belonging to this section (inclusive). */
  endLine: number;
  /** Index (in `DocumentOutline.sections`) of the enclosing section, if any. */
  parentIndex?: number;
  /** Additional anchors that also address this section (explicit `{#id}`, `<a name>`). */
  aliases?: string[];
}

/** How a document points at something. */
export type DocLinkKind =
  /** `[label](target)` or `[label][ref]`. */
  | "link"
  /** `![alt](src)` - an embedded image or diagram. */
  | "image"
  /** `<https://...>` or a bare URL in plain text. */
  | "autolink"
  /** A path named inside an inline code span, e.g. `` `src/index.ts` ``. */
  | "code-span";

/** A reference from a document to another document, file or external resource. */
export interface DocLink {
  /** Visible text (alt text for images). May be empty. */
  label: string;
  /** Raw target exactly as authored. */
  href: string;
  /** 1-based line the reference appears on. */
  line: number;
  kind: DocLinkKind;
  /** Index of the section containing this reference, if any. */
  sectionIndex?: number;
}

/** A fenced or indented code block. */
export interface DocCodeBlock {
  /** Info-string language (lower-cased), when declared. */
  language?: string;
  line: number;
  endLine: number;
  /** Block body. Truncated by the parser's `maxCodeBlockChars`. */
  content: string;
  /** Index of the section containing the block, if any. */
  sectionIndex?: number;
}

/** A `- [ ]` / `- [x]` checklist item. */
export interface DocTask {
  text: string;
  done: boolean;
  line: number;
  sectionIndex?: number;
}

/** Counts describing the document's size and shape. */
export interface DocMetrics {
  lines: number;
  words: number;
  /** Whole minutes at 200 wpm, minimum 1 for a non-empty document. */
  readingMinutes: number;
  sections: number;
  links: number;
  externalLinks: number;
  images: number;
  codeBlocks: number;
  tables: number;
  tasks: number;
  tasksDone: number;
}

/** The dialect-agnostic result of parsing one document. */
export interface DocumentOutline {
  format: DocumentFormat;
  /**
   * Best-effort document title: frontmatter `title`, else the first level-1
   * heading, else the first heading of any level.
   */
  title?: string;
  /** Parsed frontmatter (YAML/TOML), when present and parseable. */
  frontmatter?: Record<string, any>;
  /**
   * Subjects the document declares - frontmatter `tags`/`keywords`/`topics`,
   * normalised, de-duplicated and order-preserved.
   */
  tags: string[];
  sections: DocSection[];
  links: DocLink[];
  codeBlocks: DocCodeBlock[];
  tasks: DocTask[];
  metrics: DocMetrics;
  /** Non-fatal parse problems (unterminated fence, bad frontmatter, ...). */
  warnings: string[];
}

/** Knobs shared by every parser. */
export interface DocumentParseOptions {
  /** Cap on retained code-block body characters. Default 2000. */
  maxCodeBlockChars?: number;
  /** Cap on sections retained. Default 500. */
  maxSections?: number;
  /** Cap on links retained. Default 1000. */
  maxLinks?: number;
}

export const DEFAULT_PARSE_OPTIONS: Required<DocumentParseOptions> = {
  maxCodeBlockChars: 2000,
  maxSections: 500,
  maxLinks: 1000,
};

/** Match kind for symbol mentions extracted from documentation. */
export type DocMentionMatchKind = "inline-code" | "prose-pascal";

/** Metadata attached to a MENTIONS edge originating in documentation. */
export interface DocMentionData {
  confidence: number;
  match: DocMentionMatchKind;
  symbolName?: string;
  line?: number;
}

/** An entry in the project symbol index used to link documentation mentions. */
export interface SymbolIndexEntry {
  id: number;
  name: string;
  relativePath: string;
}

/** Project symbol index mapping symbol name to its candidate node entries. */
export type SymbolIndex = Map<string, SymbolIndexEntry[]>;

/** Options passed to document graphing and symbol mention linking. */
export interface DocumentGraphOptions {
  /** Symbol index or symbols list for detecting mentions in document text. */
  symbolIndex?: SymbolIndex | Map<string, number[]> | Map<string, SymbolIndexEntry[]> | any[];
  /** Feature flag: toggle emission of symbol mentions edges (default true). */
  linkDocMentions?: boolean;
}

/** Words per minute used to derive `DocMetrics.readingMinutes`. */
export const READING_WPM = 200;

/**
 * GitHub-compatible anchor slug: lower-case, punctuation dropped, whitespace
 * to hyphens. Emoji and other non-word characters are removed rather than
 * transliterated.
 */
export const slugify = (text: string): string =>
  (text || "")
    .trim()
    .toLowerCase()
    // Strip anything that is not a letter, number, space, hyphen or underscore.
    // \p{L}/\p{N} keep non-latin scripts addressable.
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * De-duplicates a slug within one document the way GitHub does: the second
 * "Overview" becomes `overview-1`, the third `overview-2`.
 */
export const uniqueSlug = (base: string, seen: Map<string, number>): string => {
  const root = base || "section";
  const count = seen.get(root) ?? 0;
  seen.set(root, count + 1);
  return count === 0 ? root : `${root}-${count}`;
};

/** Counts words for reading-time purposes (runs of non-whitespace). */
export const countWords = (text: string): number => {
  const matches = (text || "").match(/\S+/g);
  return matches ? matches.length : 0;
};

/** Empty metrics, so partial results are always well-formed. */
export const emptyMetrics = (): DocMetrics => ({
  lines: 0,
  words: 0,
  readingMinutes: 0,
  sections: 0,
  links: 0,
  externalLinks: 0,
  images: 0,
  codeBlocks: 0,
  tables: 0,
  tasks: 0,
  tasksDone: 0,
});
