import yaml from "js-yaml";
import {
  DEFAULT_PARSE_OPTIONS,
  DocCodeBlock,
  DocLink,
  DocSection,
  DocTask,
  DocumentFormat,
  DocumentOutline,
  DocumentParseOptions,
  READING_WPM,
  countWords,
  emptyMetrics,
  slugify,
  uniqueSlug,
} from "./DocumentTypes";

/**
 * A line-oriented markdown parser producing a `DocumentOutline`.
 *
 * It is a block scanner, not a CommonMark implementation - it extracts the
 * structure the graph needs (headings, links, images, code blocks, tables,
 * checklists, frontmatter) and ignores the rest of the grammar. What it does
 * guarantee is that structure is only recognised where it is really structure:
 *
 *  - `#` inside a fenced code block is code, not a heading,
 *  - `[a](b)` inside a code span or code fence is not a link,
 *  - `---` is frontmatter only at the top of the file, a setext underline only
 *    directly under a paragraph line, and a thematic break otherwise.
 *
 * Those three cases are exactly what a naive line-regex pass gets wrong, and
 * getting them wrong pollutes the graph with phantom sections and edges.
 */

/** Opening/closing fence: >=3 backticks or tildes, optional info string. */
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`]*)$/;
/** ATX heading, with optional closing hashes and optional `{#custom-id}`. */
const ATX_RE = /^(\s{0,3})(#{1,6})(\s+|$)(.*)$/;
/** Setext underline: a run of `=` (h1) or `-` (h2). */
const SETEXT_RE = /^(\s{0,3})(=+|-+)\s*$/;
/** Link reference definition: `[label]: url "title"`. */
const REF_DEF_RE = /^(\s{0,3})\[([^\]]+)\]:\s*(\S+)(\s+.*)?$/;
/** GitHub task list item. */
const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/;
/** Table delimiter row, e.g. `|---|:--:|`. */
const TABLE_DELIM_RE = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** Explicit heading id: `## Title {#custom-id}`. */
const HEADING_ID_RE = /\{#([^}\s]+)\}\s*$/;
/** `<a name="anchor">` / `<a id="anchor">` anchor. */
const HTML_ANCHOR_RE = /<a\s+(?:name|id)\s*=\s*["']([^"']+)["']/gi;
/** Bare URL in prose. */
const BARE_URL_RE = /(?<![("<[])\bhttps?:\/\/[^\s<>()[\]"'`]+/g;
/** Autolink `<https://...>` / `<mailto:...>`. */
const AUTOLINK_RE = /<((?:[a-z][a-z0-9+.-]*:|mailto:)[^\s<>]+)>/gi;

/**
 * A code span whose content looks like a repo path - `src/index.ts`,
 * `./scripts/build.sh`. A directory separator *and* a file extension are both
 * required: that keeps this off every `someVariable` in the prose, and off bare
 * filenames like `package.json` or `README.md`, which prose almost always
 * mentions generically rather than as a reference to that specific file.
 */
const PATHISH_RE = /^\.{0,2}\/?(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}$/;

/** Strips inline markup so a heading yields clean display text. */
export const stripInlineMarkup = (text: string): string =>
  (text || "")
    // images first (they contain a link-shaped tail)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .trim();

/** A reference-style link awaiting resolution against the definitions map. */
interface PendingRef {
  label: string;
  refId: string;
  line: number;
  sectionIndex?: number;
  isImage: boolean;
}

/** Mutable state threaded through the block scan. */
interface ScanState {
  sections: DocSection[];
  links: DocLink[];
  codeBlocks: DocCodeBlock[];
  tasks: DocTask[];
  pendingRefs: PendingRef[];
  definitions: Map<string, string>;
  /** Section index stack, indexed by heading level. */
  openByLevel: (number | undefined)[];
  currentSection?: number;
  slugsSeen: Map<string, number>;
  tables: number;
  warnings: string[];
}

/**
 * Extracts frontmatter delimited by `---` (YAML) or `+++` (TOML) at the very
 * start of the document. Returns the parsed object plus the line offset of the
 * body so every subsequent line number stays true to the original file.
 */
const readFrontmatter = (
  lines: string[],
  warnings: string[]
): { frontmatter?: Record<string, any>; bodyStart: number } => {
  if (lines.length === 0) return { bodyStart: 0 };
  const opener = lines[0].trim();
  const isYaml = opener === "---";
  const isToml = opener === "+++";
  if (!isYaml && !isToml) return { bodyStart: 0 };

  const closer = isYaml ? "---" : "+++";
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== closer) continue;
    const raw = lines.slice(1, i).join("\n");
    if (isToml) {
      // No TOML parser is available; the block is still consumed so its
      // contents are never mistaken for body structure.
      warnings.push("TOML frontmatter is skipped (no parser available)");
      return { bodyStart: i + 1 };
    }
    try {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { frontmatter: parsed as Record<string, any>, bodyStart: i + 1 };
      }
      return { bodyStart: i + 1 };
    } catch (err) {
      warnings.push(`Unparseable YAML frontmatter: ${(err as Error).message}`);
      return { bodyStart: i + 1 };
    }
  }
  // Unterminated: treat the whole file as body rather than swallowing it.
  return { bodyStart: 0 };
};

/**
 * Normalises frontmatter tag-ish fields into a flat, de-duplicated list.
 * Accepts `tags`, `keywords`, `topics`, `categories` as a list or a
 * comma/space-separated string.
 */
export const extractTags = (frontmatter?: Record<string, any>): string[] => {
  if (!frontmatter) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    if (typeof value === "object") return;
    for (const part of `${value}`.split(/[,;]/)) {
      const tag = part.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  };
  ["tags", "keywords", "topics", "categories"].forEach((field) =>
    push(frontmatter[field])
  );
  return out;
};

/** Registers a heading, closing any sections it terminates. */
const openSection = (
  state: ScanState,
  title: string,
  level: number,
  line: number,
  maxSections: number
): void => {
  // Close sections at this level or deeper - their content ended on the
  // previous line.
  for (let l = level; l <= 6; l++) {
    const open = state.openByLevel[l];
    if (open !== undefined) {
      state.sections[open].endLine = Math.max(
        state.sections[open].line,
        line - 1
      );
      state.openByLevel[l] = undefined;
    }
  }

  if (state.sections.length >= maxSections) {
    // Content still belongs to the last accepted section.
    return;
  }

  let explicitId: string | undefined;
  const idMatch = title.match(HEADING_ID_RE);
  let displayTitle = title;
  if (idMatch) {
    explicitId = idMatch[1];
    displayTitle = title.slice(0, idMatch.index);
  }
  displayTitle = stripInlineMarkup(displayTitle);

  // An explicit `{#id}` wins; it is what the anchors in other documents use.
  const base = explicitId ? explicitId.toLowerCase() : slugify(displayTitle);
  const slug = uniqueSlug(base, state.slugsSeen);

  // The nearest still-open shallower heading is the parent.
  let parentIndex: number | undefined;
  for (let l = level - 1; l >= 1; l--) {
    if (state.openByLevel[l] !== undefined) {
      parentIndex = state.openByLevel[l];
      break;
    }
  }

  const index = state.sections.length;
  state.sections.push({
    title: displayTitle || slug,
    level,
    slug,
    line,
    endLine: line,
    parentIndex,
    aliases: explicitId && explicitId.toLowerCase() !== slug ? [explicitId.toLowerCase()] : undefined,
  });
  state.openByLevel[level] = index;
  state.currentSection = index;
};

/** Records a link, honouring the retained-links cap. */
const pushLink = (state: ScanState, link: DocLink, maxLinks: number): void => {
  if (state.links.length >= maxLinks) return;
  state.links.push(link);
};

/** Cleans a link destination: strips `<>` wrappers and a trailing title. */
const cleanDestination = (raw: string): string => {
  let dest = (raw || "").trim();
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
  return dest.trim();
};

/**
 * Scans one line's inline content for links, images, autolinks, bare URLs,
 * path-like code spans and HTML anchors.
 *
 * Code spans are honoured: a `[a](b)` inside backticks produces no link. This
 * is a single-line scanner - a link split across a newline is not recognised,
 * which is a deliberate trade for predictability.
 */
const scanInline = (
  line: string,
  lineNo: number,
  state: ScanState,
  maxLinks: number
): void => {
  const sectionIndex = state.currentSection;
  // Text with code spans blanked out, used for the regex-based passes so they
  // cannot match inside code. Length is preserved so offsets stay comparable.
  let masked = "";
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    // ---- code span --------------------------------------------------------
    if (ch === "`") {
      let run = 0;
      while (line[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = line.indexOf(fence, i + run);
      if (close === -1) {
        // Unterminated on this line: treat the backticks as literal text.
        masked += line.slice(i, i + run);
        i += run;
        continue;
      }
      const content = line.slice(i + run, close).trim();
      if (content && PATHISH_RE.test(content)) {
        pushLink(
          state,
          { label: content, href: content, line: lineNo, kind: "code-span", sectionIndex },
          maxLinks
        );
      }
      masked += " ".repeat(close + run - i);
      i = close + run;
      continue;
    }

    // ---- image / link -----------------------------------------------------
    const isImage = ch === "!" && line[i + 1] === "[";
    if (ch === "[" || isImage) {
      const labelStart = i + (isImage ? 2 : 1);
      let depth = 1;
      let j = labelStart;
      while (j < line.length && depth > 0) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === "[") depth++;
        else if (line[j] === "]") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth !== 0) {
        // Unbalanced - emit the bracket as text and move on.
        masked += ch;
        i++;
        continue;
      }
      const label = line.slice(labelStart, j);
      let k = j + 1;

      if (line[k] === "(") {
        // Inline destination, with nesting tolerance for `(a(b))`.
        let pdepth = 1;
        let m = k + 1;
        while (m < line.length && pdepth > 0) {
          if (line[m] === "\\") {
            m += 2;
            continue;
          }
          if (line[m] === "(") pdepth++;
          else if (line[m] === ")") pdepth--;
          if (pdepth === 0) break;
          m++;
        }
        if (pdepth === 0) {
          const inner = line.slice(k + 1, m);
          // Drop a trailing "title" / 'title' / (title).
          const dest = cleanDestination(
            inner.replace(/\s+(".*"|'.*'|\(.*\))\s*$/, "")
          );
          if (dest) {
            pushLink(
              state,
              {
                label: stripInlineMarkup(label),
                href: dest,
                line: lineNo,
                kind: isImage ? "image" : "link",
                sectionIndex,
              },
              maxLinks
            );
          }
          masked += " ".repeat(m + 1 - i);
          i = m + 1;
          continue;
        }
      } else if (line[k] === "[") {
        // Reference style: `[text][id]` or collapsed `[text][]`.
        const close = line.indexOf("]", k + 1);
        if (close !== -1) {
          const refId = line.slice(k + 1, close).trim() || label;
          state.pendingRefs.push({
            label: stripInlineMarkup(label),
            refId,
            line: lineNo,
            sectionIndex,
            isImage,
          });
          masked += " ".repeat(close + 1 - i);
          i = close + 1;
          continue;
        }
      } else if (!isImage && label && !label.includes("\n")) {
        // Shortcut reference `[id]` - only meaningful if a definition exists,
        // which is resolved later.
        state.pendingRefs.push({
          label: stripInlineMarkup(label),
          refId: label,
          line: lineNo,
          sectionIndex,
          isImage: false,
        });
      }
      masked += " ".repeat(j + 1 - i);
      i = j + 1;
      continue;
    }

    masked += ch;
    i++;
  }

  // ---- passes over the code-masked text ----------------------------------
  let m: RegExpExecArray | null;

  AUTOLINK_RE.lastIndex = 0;
  while ((m = AUTOLINK_RE.exec(masked)) !== null) {
    pushLink(
      state,
      { label: m[1], href: m[1], line: lineNo, kind: "autolink", sectionIndex },
      maxLinks
    );
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(masked)) !== null) {
    // Trailing sentence punctuation is not part of the URL.
    const href = m[0].replace(/[.,;:!?]+$/, "");
    pushLink(
      state,
      { label: href, href, line: lineNo, kind: "autolink", sectionIndex },
      maxLinks
    );
  }

  HTML_ANCHOR_RE.lastIndex = 0;
  while ((m = HTML_ANCHOR_RE.exec(masked)) !== null) {
    const anchor = m[1].toLowerCase();
    const section = sectionIndex !== undefined ? state.sections[sectionIndex] : undefined;
    if (section && section.slug !== anchor) {
      section.aliases = Array.from(new Set([...(section.aliases || []), anchor]));
    }
  }
};

/**
 * Parses a markdown (or MDX) document into a `DocumentOutline`.
 *
 * @param content raw file contents
 * @param format  reported on the outline; `mdx` is parsed identically
 */
export const parseMarkdown = (
  content: string,
  format: DocumentFormat = "markdown",
  options: DocumentParseOptions = {}
): DocumentOutline => {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
  const warnings: string[] = [];
  const text = content || "";
  const lines = text.split(/\r?\n/);

  const { frontmatter, bodyStart } = readFrontmatter(lines, warnings);

  const state: ScanState = {
    sections: [],
    links: [],
    codeBlocks: [],
    tasks: [],
    pendingRefs: [],
    definitions: new Map(),
    openByLevel: new Array(7).fill(undefined),
    slugsSeen: new Map(),
    tables: 0,
    warnings,
  };

  let words = 0;
  let inFence = false;
  let fenceMarker = "";
  let fenceIndent = 0;
  let fenceStartLine = 0;
  let fenceLanguage: string | undefined;
  let fenceBody: string[] = [];
  let inHtmlComment = false;
  /** The previous line's trimmed text, for setext-underline detection. */
  let previousLine = "";
  let previousWasBlank = true;

  const closeFence = (endLine: number) => {
    const body = fenceBody.join("\n");
    state.codeBlocks.push({
      language: fenceLanguage,
      line: fenceStartLine,
      endLine,
      content: body.slice(0, opts.maxCodeBlockChars),
      sectionIndex: state.currentSection,
    });
    inFence = false;
    fenceMarker = "";
    fenceBody = [];
    fenceLanguage = undefined;
  };

  for (let idx = bodyStart; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNo = idx + 1;
    const trimmed = raw.trim();

    // ---- fenced code ------------------------------------------------------
    if (inFence) {
      // A closing fence is a run of >= the opening length of the same
      // character, with nothing else on the line.
      const closing = raw.trim();
      const isClosing =
        closing.length >= fenceMarker.length &&
        closing === closing[0].repeat(closing.length) &&
        closing[0] === fenceMarker[0];
      if (isClosing) {
        closeFence(lineNo);
      } else {
        // Strip up to the fence's own indentation, as CommonMark does.
        const indent = raw.length - raw.trimStart().length;
        fenceBody.push(raw.slice(Math.min(fenceIndent, indent)));
      }
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    const fence = raw.match(FENCE_RE);
    if (fence) {
      inFence = true;
      fenceIndent = fence[1].length;
      fenceMarker = fence[2];
      fenceStartLine = lineNo;
      const info = (fence[3] || "").trim();
      fenceLanguage = info ? info.split(/\s+/)[0].toLowerCase() : undefined;
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    // ---- HTML comments ----------------------------------------------------
    if (inHtmlComment) {
      if (raw.includes("-->")) inHtmlComment = false;
      previousLine = "";
      previousWasBlank = false;
      continue;
    }
    if (trimmed.startsWith("<!--") && !trimmed.includes("-->")) {
      inHtmlComment = true;
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    if (trimmed.length === 0) {
      previousLine = "";
      previousWasBlank = true;
      continue;
    }

    // ---- headings ---------------------------------------------------------
    const atx = raw.match(ATX_RE);
    if (atx) {
      // `#hashtag` is not a heading - a space (or end of line) must follow.
      const title = (atx[4] || "").replace(/\s+#+\s*$/, "").trim();
      openSection(state, title, atx[2].length, lineNo, opts.maxSections);
      // A heading's own inline content can still carry links.
      scanInline(title, lineNo, state, opts.maxLinks);
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    // A setext underline only applies to a preceding *paragraph* line. Under a
    // table header row it is a delimiter; under a list item or block quote it
    // is a thematic break.
    const setext = raw.match(SETEXT_RE);
    const previousIsParagraph =
      !!previousLine &&
      !previousWasBlank &&
      !previousLine.includes("|") &&
      !/^([-*+]\s|\d+[.)]\s|>)/.test(previousLine);
    if (setext && previousIsParagraph) {
      const level = setext[2][0] === "=" ? 1 : 2;
      // The heading text lives on the *previous* line.
      openSection(state, previousLine, level, lineNo - 1, opts.maxSections);
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    // ---- link reference definitions ---------------------------------------
    const refDef = raw.match(REF_DEF_RE);
    if (refDef) {
      state.definitions.set(refDef[2].trim().toLowerCase(), cleanDestination(refDef[3]));
      previousLine = "";
      previousWasBlank = false;
      continue;
    }

    // ---- tables -----------------------------------------------------------
    if (TABLE_DELIM_RE.test(raw) && previousLine.includes("|")) {
      state.tables++;
      previousLine = trimmed;
      previousWasBlank = false;
      continue;
    }

    // ---- task list items --------------------------------------------------
    const task = raw.match(TASK_RE);
    if (task) {
      state.tasks.push({
        text: stripInlineMarkup(task[4]),
        done: task[3].toLowerCase() === "x",
        line: lineNo,
        sectionIndex: state.currentSection,
      });
    }

    words += countWords(trimmed);
    scanInline(raw, lineNo, state, opts.maxLinks);
    previousLine = trimmed;
    previousWasBlank = false;
  }

  if (inFence) {
    warnings.push(`Unterminated code fence opened on line ${fenceStartLine}`);
    closeFence(lines.length);
  }

  // Close every still-open section at the end of the document.
  const lastLine = Math.max(lines.length, 1);
  for (let l = 1; l <= 6; l++) {
    const open = state.openByLevel[l];
    if (open !== undefined) {
      state.sections[open].endLine = Math.max(state.sections[open].line, lastLine);
    }
  }

  // Resolve reference-style links now that all definitions are known.
  for (const ref of state.pendingRefs) {
    const dest = state.definitions.get(ref.refId.trim().toLowerCase());
    if (!dest) continue; // a shortcut with no definition is just text
    if (state.links.length >= opts.maxLinks) break;
    state.links.push({
      label: ref.label,
      href: dest,
      line: ref.line,
      kind: ref.isImage ? "image" : "link",
      sectionIndex: ref.sectionIndex,
    });
  }

  const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
  const externalLinks = state.links.filter((l) => isExternal(l.href)).length;
  const images = state.links.filter((l) => l.kind === "image").length;

  const frontmatterTitle =
    frontmatter && typeof frontmatter.title === "string" ? frontmatter.title.trim() : undefined;
  const title =
    frontmatterTitle ||
    state.sections.find((s) => s.level === 1)?.title ||
    state.sections[0]?.title;

  return {
    format,
    title: title || undefined,
    frontmatter,
    tags: extractTags(frontmatter),
    sections: state.sections,
    links: state.links,
    codeBlocks: state.codeBlocks,
    tasks: state.tasks,
    metrics: {
      ...emptyMetrics(),
      lines: lines.length,
      words,
      readingMinutes: words > 0 ? Math.max(1, Math.round(words / READING_WPM)) : 0,
      sections: state.sections.length,
      links: state.links.length,
      externalLinks,
      images,
      codeBlocks: state.codeBlocks.length,
      tables: state.tables,
      tasks: state.tasks.length,
      tasksDone: state.tasks.filter((t) => t.done).length,
    },
    warnings,
  };
};

export default parseMarkdown;
