import fs from "fs";
import path from "path";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode } from "../../../types/model.types";
import { DocumentFormat, DocumentOutline, DocumentParseOptions } from "./DocumentTypes";
import { parseMarkdown } from "./MarkdownParser";
import { parsePlainText } from "./PlainTextParser";
import { DocumentGraph, emitDocumentGraph } from "./DocumentGraphEmitter";

export * from "./DocumentTypes";
export { parseMarkdown } from "./MarkdownParser";
export { parsePlainText } from "./PlainTextParser";
export {
  buildSymbolIndex,
  disambiguateSymbol,
  emitDocumentGraph,
  isAssetTarget,
  isCodeTarget,
  isDocumentTarget,
  linkDocSymbolMentions,
  normalizeExternalUrl,
  normalizeSymbolIndex,
  resolveDocumentTarget,
  sanitizeFrontmatter,
  SYMBOL_DENYLIST,
} from "./DocumentGraphEmitter";
export type { DocumentGraph } from "./DocumentGraphEmitter";

/**
 * Documentation graphing entry point.
 *
 * A document is graphed in two stages - parse to a dialect-agnostic outline,
 * then emit deterministic nodes and edges from that outline. This module picks
 * the parser for a file and runs both stages.
 */

/** Extension -> document dialect. */
const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkd": "markdown",
  ".mdx": "mdx",
  ".rst": "restructuredtext",
  ".adoc": "asciidoc",
  ".asciidoc": "asciidoc",
  ".asc": "asciidoc",
  ".txt": "text",
  ".text": "text",
};

/**
 * Extension-less files that are documents by convention. `LICENSE` and
 * `CODEOWNERS` are included: they carry no prose structure worth outlining, but
 * they are documents, and a documentation project should show them as such.
 */
const BARE_DOCUMENT_NAMES = new Set([
  "README",
  "CHANGELOG",
  "CHANGES",
  "HISTORY",
  "LICENSE",
  "LICENCE",
  "NOTICE",
  "CONTRIBUTING",
  "AUTHORS",
  "MAINTAINERS",
  "CODEOWNERS",
  "TODO",
  "INSTALL",
  "UPGRADING",
  "SECURITY",
]);

/**
 * The `language` values (as produced by BaseProjectProcessor.languageForFile)
 * that the document analyzers handle.
 */
export const DOCUMENT_LANGUAGES = new Set<string>([
  "markdown",
  "mdx",
  "restructuredtext",
  "asciidoc",
  "text",
]);

/** The document dialect for a file name, or null when it is not a document. */
export const documentFormatFor = (fileName: string): DocumentFormat | null => {
  if (!fileName) return null;
  const base = path.basename(fileName);
  const ext = path.extname(base).toLowerCase();
  if (ext) {
    const format = FORMAT_BY_EXTENSION[ext];
    if (format) return format;
    // `README.foo` is not a document; `CHANGELOG.old` is not either.
    return null;
  }
  return BARE_DOCUMENT_NAMES.has(base.toUpperCase()) ? "text" : null;
};

/** True when the document analyzers can outline this file. */
export const isDocumentFile = (fileName: string, language?: string): boolean =>
  (!!language && DOCUMENT_LANGUAGES.has(language)) || documentFormatFor(fileName) !== null;

/** Parses document content with the parser for `format`. */
export const parseDocument = (
  content: string,
  format: DocumentFormat,
  options?: DocumentParseOptions
): DocumentOutline => {
  switch (format) {
    case "markdown":
    case "mdx":
      return parseMarkdown(content, format, options);
    case "restructuredtext":
    case "asciidoc":
      // Both dialects use ATX-ish headings (`==` underlines for rst, `==` prefixes
      // for adoc) that the plain-text parser's underline/title heuristics pick up.
      // A dedicated parser can be slotted in here without touching the emitter.
      return { ...parsePlainText(content, options), format };
    case "text":
    default:
      return parsePlainText(content, options);
  }
};

/** Largest document read into memory. Beyond this only the head is parsed. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * Reads, parses and graphs a document FILE node.
 *
 * Returns an empty graph (never throws) when the file is missing, is not a
 * document, or the node is missing the project context the emitter needs -
 * processing a project must not fail because one document is unreadable.
 */
export const analyseDocumentFile = (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext,
  options?: DocumentGraphOptions
): DocumentGraph => {
  const empty: DocumentGraph = { symbols: [], externals: [], edges: [], filePatch: {} };
  const data = fileNode?.data || {};
  const filePath: string = data.path;
  if (!filePath || !data.projectFqn || !data.relativePath) return empty;

  const format =
    (DOCUMENT_LANGUAGES.has(data.language) ? (data.language as DocumentFormat) : null) ??
    documentFormatFor(filePath);
  if (!format) return empty;

  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return empty;
    if (stat.size > MAX_DOCUMENT_BYTES) {
      const handle = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES);
        const read = fs.readSync(handle, buffer, 0, MAX_DOCUMENT_BYTES, 0);
        content = buffer.slice(0, read).toString("utf-8");
        context?.warn(
          `Document ${data.relativePath} exceeds ${MAX_DOCUMENT_BYTES} bytes; outlining the first ${MAX_DOCUMENT_BYTES}`
        );
      } finally {
        fs.closeSync(handle);
      }
    } else {
      content = fs.readFileSync(filePath, "utf-8");
    }
  } catch (err) {
    context?.warn(`Cannot read document ${filePath}: ${(err as Error).message}`);
    return empty;
  }

  try {
    const outline = parseDocument(content, format);
    return emitDocumentGraph(fileNode, outline, options, content);
  } catch (err) {
    context?.error(
      `Document analysis failed for ${data.relativePath}: ${(err as Error).message}`
    );
    return empty;
  }
};
