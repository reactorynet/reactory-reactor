import {
  DEFAULT_PARSE_OPTIONS,
  DocLink,
  DocSection,
  DocumentOutline,
  DocumentParseOptions,
  READING_WPM,
  countWords,
  emptyMetrics,
  slugify,
  uniqueSlug,
} from "./DocumentTypes";

/**
 * A parser for documents with no markup dialect: `.txt`, extension-less
 * `README`, `CHANGELOG`, `LICENSE`.
 *
 * Plain text has no headings, so structure has to be inferred. Three
 * conventions are recognised, in order of confidence:
 *
 *  1. an underlined title (`Overview` followed by `=====` or `-----`),
 *  2. a numbered section (`1.`, `2.3`, `IV.`), whose depth sets the level,
 *  3. a short ALL-CAPS or Title Case line surrounded by blank lines.
 *
 * Only (1) and (2) are strong signals; (3) is accepted only when the line is
 * short, followed by a blank line and not sentence-like, which keeps ordinary
 * prose from being promoted to a section.
 */

/** `=====` / `-----` / `~~~~~` underline. */
const UNDERLINE_RE = /^([=\-~*_#]){3,}\s*$/;
/** `1.`, `1.2.3`, `A.`, `IV)` prefixes. */
const NUMBERED_RE = /^(\s*)((?:\d+|[A-Z]|[IVXLC]+)(?:\.\d+)*)[.)]\s+(\S.*)$/;
/** Bare URLs and mailto addresses. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"']+/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
/** A path-like token, e.g. `src/index.ts` or `./bin/run.sh`. */
const PATH_TOKEN_RE = /(?:^|\s)(\.{0,2}\/?(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s,;:)])/g;

/** True for a line that reads like a section title rather than prose. */
const looksLikeTitle = (line: string): boolean => {
  const text = line.trim();
  if (text.length === 0 || text.length > 80) return false;
  // Sentence-like lines are prose, not titles.
  if (/[.!?;]$/.test(text)) return false;
  if (text.split(/\s+/).length > 10) return false;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
  // ALL CAPS, or Title Case With Most Words Capitalised.
  if (upperRatio > 0.85) return true;
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length === 0) return false;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / words.length >= 0.75;
};

/** Depth of a numbered prefix: `1.` -> 1, `1.2` -> 2, capped at 6. */
const numberedLevel = (marker: string): number =>
  Math.min(6, marker.split(".").filter(Boolean).length);

export const parsePlainText = (
  content: string,
  options: DocumentParseOptions = {}
): DocumentOutline => {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
  const lines = (content || "").split(/\r?\n/);

  const sections: DocSection[] = [];
  const links: DocLink[] = [];
  const slugsSeen = new Map<string, number>();
  const openByLevel: (number | undefined)[] = new Array(7).fill(undefined);
  let currentSection: number | undefined;
  let words = 0;

  const open = (title: string, level: number, line: number) => {
    if (sections.length >= opts.maxSections) return;
    for (let l = level; l <= 6; l++) {
      const idx = openByLevel[l];
      if (idx !== undefined) {
        sections[idx].endLine = Math.max(sections[idx].line, line - 1);
        openByLevel[l] = undefined;
      }
    }
    let parentIndex: number | undefined;
    for (let l = level - 1; l >= 1; l--) {
      if (openByLevel[l] !== undefined) {
        parentIndex = openByLevel[l];
        break;
      }
    }
    const clean = title.trim();
    const index = sections.length;
    sections.push({
      title: clean,
      level,
      slug: uniqueSlug(slugify(clean), slugsSeen),
      line,
      endLine: line,
      parentIndex,
    });
    openByLevel[level] = index;
    currentSection = index;
  };

  const pushLink = (link: DocLink) => {
    if (links.length >= opts.maxLinks) return;
    links.push(link);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    // (1) Underlined title - the title is on the previous line.
    const next = (lines[i + 1] || "").trim();
    if (
      next.length > 0 &&
      UNDERLINE_RE.test(next) &&
      trimmed.length > 0 &&
      !UNDERLINE_RE.test(trimmed)
    ) {
      // `=` outranks `-`, mirroring the markdown convention.
      open(trimmed, next[0] === "=" ? 1 : 2, lineNo);
      i++; // consume the underline
      continue;
    }
    if (UNDERLINE_RE.test(trimmed)) continue;

    // (2) Numbered section.
    const numbered = raw.match(NUMBERED_RE);
    if (numbered && looksLikeTitle(numbered[3])) {
      open(numbered[3], numberedLevel(numbered[2]), lineNo);
      continue;
    }

    // (3) A short standalone capitalised line, blank-line delimited.
    const prevBlank = i === 0 || (lines[i - 1] || "").trim().length === 0;
    const nextBlank = next.length === 0;
    if (prevBlank && nextBlank && looksLikeTitle(trimmed)) {
      open(trimmed, 2, lineNo);
      continue;
    }

    words += countWords(trimmed);

    let m: RegExpExecArray | null;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(raw)) !== null) {
      const href = m[0].replace(/[.,;:!?]+$/, "");
      pushLink({
        label: href,
        href: href.startsWith("www.") ? `https://${href}` : href,
        line: lineNo,
        kind: "autolink",
        sectionIndex: currentSection,
      });
    }
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(raw)) !== null) {
      pushLink({
        label: m[0],
        href: `mailto:${m[0]}`,
        line: lineNo,
        kind: "autolink",
        sectionIndex: currentSection,
      });
    }
    PATH_TOKEN_RE.lastIndex = 0;
    while ((m = PATH_TOKEN_RE.exec(raw)) !== null) {
      pushLink({
        label: m[1],
        href: m[1],
        line: lineNo,
        kind: "code-span",
        sectionIndex: currentSection,
      });
    }
  }

  const lastLine = Math.max(lines.length, 1);
  for (let l = 1; l <= 6; l++) {
    const idx = openByLevel[l];
    if (idx !== undefined) sections[idx].endLine = Math.max(sections[idx].line, lastLine);
  }

  const externalLinks = links.filter((l) => /^[a-z][a-z0-9+.-]*:/i.test(l.href)).length;

  return {
    format: "text",
    title: sections.find((s) => s.level === 1)?.title || sections[0]?.title,
    tags: [],
    sections,
    links,
    codeBlocks: [],
    tasks: [],
    metrics: {
      ...emptyMetrics(),
      lines: lines.length,
      words,
      readingMinutes: words > 0 ? Math.max(1, Math.round(words / READING_WPM)) : 0,
      sections: sections.length,
      links: links.length,
      externalLinks,
    },
    warnings: [],
  };
};

export default parsePlainText;
