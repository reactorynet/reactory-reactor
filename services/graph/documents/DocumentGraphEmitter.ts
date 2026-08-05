import fs from "fs";
import path from "path";
import {
  ReactorLinkType,
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
} from "../../../types/model.types";
import {
  appendAncestry,
  linkId,
  nodeId,
  normalizeRelative,
  pathLogicalKey,
  symbolLogicalKey,
} from "../GraphIdentity";
import { DocLink, DocumentOutline, slugify } from "./DocumentTypes";

/**
 * The graph produced from one document. Mirrors the code analyzers'
 * `FileAnalysis`, with a patch for the document's own file node.
 */
export interface DocumentGraph {
  /** SECTION nodes - children of the document node, nested by heading level. */
  symbols: ReactorNode[];
  /** Project-scoped TOPIC and RESOURCE nodes this document introduces. */
  externals: ReactorNode[];
  edges: ReactorNodeLink[];
  /** Fields to merge onto the document's own file node. */
  filePatch: {
    description?: string;
    data?: Record<string, any>;
  };
}

/** Extensions treated as source/config a document can be said to *document*. */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".kts",
  ".cs", ".go", ".rb", ".php", ".rs", ".swift", ".dart", ".scala", ".groovy",
  ".sql", ".sh", ".bash", ".zsh", ".ps1", ".tf", ".tfvars", ".yaml", ".yml",
  ".json", ".toml", ".ini", ".proto", ".graphql", ".gql", ".dockerfile",
]);

/** Extensions treated as embeddable assets (images, diagrams, video). */
const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
  ".mp4", ".webm", ".mov", ".pdf", ".drawio", ".puml", ".mmd",
]);

/** Extensions the document analyzers can outline. */
const DOCUMENT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".adoc", ".asciidoc", ".txt",
]);

/** Filenames without an extension that are conventionally documents. */
const BARE_DOCUMENT_NAMES = new Set([
  "README", "CHANGELOG", "CHANGES", "LICENSE", "LICENCE", "NOTICE",
  "CONTRIBUTING", "AUTHORS", "CODEOWNERS", "TODO", "INSTALL",
]);

export const isCodeTarget = (relativePath: string): boolean =>
  CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

export const isAssetTarget = (relativePath: string): boolean =>
  ASSET_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

export const isDocumentTarget = (relativePath: string): boolean => {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext) return DOCUMENT_EXTENSIONS.has(ext);
  return BARE_DOCUMENT_NAMES.has(path.basename(relativePath).toUpperCase());
};

/** True when a link destination points outside the filesystem (URL, mailto, ...). */
const hasScheme = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** Extensions tried for an extension-less link, as docs sites use. */
const IMPLICIT_EXTENSIONS = [".md", ".markdown", ".mdx", ".rst", ".adoc"];
/** Index documents tried when a link points at a directory. */
const DIRECTORY_INDEXES = [
  "index.md",
  "README.md",
  "readme.md",
  "index.mdx",
  "index.rst",
  "index.adoc",
];

/** A link destination resolved against the repository. */
interface ResolvedTarget {
  /** Repo-relative posix path of the target file or folder. */
  relativePath: string;
  /** Anchor fragment, if the link carried one. */
  anchor?: string;
  isDirectory: boolean;
}

/**
 * Resolves a relative link destination to a path inside the repository.
 *
 * Returns null for URLs, for destinations that escape the repo root, and for
 * paths that do not exist - an edge to a node that will never be created is
 * worse than no edge, because it shows up in the explorer as a dangling
 * "Unresolved node".
 */
export const resolveDocumentTarget = (
  href: string,
  fromFileAbsPath: string,
  repoPath: string
): ResolvedTarget | null => {
  if (!href || hasScheme(href)) return null;

  // Split off the anchor and query string.
  const hashIndex = href.indexOf("#");
  let target = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? undefined : href.slice(hashIndex + 1) || undefined;
  target = target.split("?")[0];

  // A pure anchor (`#setup`) is handled by the caller as an intra-document link.
  if (target.length === 0) return null;

  try {
    target = decodeURIComponent(target);
  } catch {
    // Malformed percent-encoding - use the raw value.
  }

  // Resolve in canonical (realpath) space on both sides. Mixing canonical and
  // non-canonical paths makes path.relative() degrade into a "../.." walk and
  // every in-repo link get rejected as escaping the repo - which is exactly
  // what happens on macOS, where /var is a symlink to /private/var.
  const canonical = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const realRepoPath = canonical(repoPath);
  const fromDirectory = canonical(path.dirname(fromFileAbsPath));

  // A leading "/" is site-root-relative, i.e. relative to the repo root.
  const base = target.startsWith("/")
    ? path.join(realRepoPath, target)
    : path.resolve(fromDirectory, target);

  // Never emit an edge to something outside the repository - the node for it
  // will never exist, and a dangling endpoint shows up in the explorer as an
  // "Unresolved node".
  const relativeBase = path.relative(realRepoPath, base);
  if (relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) return null;

  const statOf = (candidate: string): fs.Stats | null => {
    try {
      return fs.statSync(candidate);
    } catch {
      return null;
    }
  };

  const found = (candidate: string, isDirectory: boolean): ResolvedTarget => ({
    relativePath: normalizeRelative(path.relative(realRepoPath, candidate)),
    anchor: anchor ? slugify(decodeAnchor(anchor)) : undefined,
    isDirectory,
  });

  const baseStat = statOf(base);
  if (baseStat?.isFile()) return found(base, false);

  // Extension-less link to a sibling document: `[guide](./guide)`.
  if (!baseStat && !path.extname(base)) {
    for (const ext of IMPLICIT_EXTENSIONS) {
      if (statOf(base + ext)?.isFile()) return found(base + ext, false);
    }
  }

  if (baseStat?.isDirectory()) {
    // A directory link means its index document when there is one, so that
    // `[docs](./docs)` lands on the page a reader would actually see.
    for (const index of DIRECTORY_INDEXES) {
      const candidate = path.join(base, index);
      if (statOf(candidate)?.isFile()) return found(candidate, false);
    }
    return found(base, true);
  }

  return null;
};

/** Decodes and normalises an anchor fragment. */
const decodeAnchor = (anchor: string): string => {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
};

/**
 * Normalises an external URL for identity purposes: lower-cased scheme+host,
 * default ports and tracking-free. Two documents linking `HTTPS://Example.com/a`
 * and `https://example.com/a` must land on the same RESOURCE node.
 */
export const normalizeExternalUrl = (href: string): string => {
  const raw = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    // Trailing slash on a bare host is noise.
    const normalized = url.toString();
    return normalized.endsWith("/") && url.pathname === "/" ? normalized.slice(0, -1) : normalized;
  } catch {
    return raw.trim();
  }
};

/** Guard rails for frontmatter, which is arbitrary author-supplied YAML. */
const MAX_FRONTMATTER_DEPTH = 6;
const MAX_FRONTMATTER_KEYS = 100;
const MAX_FRONTMATTER_STRING = 2000;

/**
 * Makes a parsed frontmatter object safe to persist as a Mongo subdocument.
 *
 * Frontmatter keys are whatever the author wrote, and MongoDB rejects field
 * names containing "." or starting with "$" - one document with a key like
 * `build.number` would otherwise fail the bulk write for its whole batch. Also
 * bounds depth, breadth and string length so a pathological block cannot bloat
 * every node in the graph.
 */
export const sanitizeFrontmatter = (
  value: unknown,
  depth = 0
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, MAX_FRONTMATTER_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_FRONTMATTER_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_FRONTMATTER_KEYS)
      .map((entry) => sanitizeFrontmatter(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_FRONTMATTER_KEYS)) {
      const safeKey = key.replace(/\./g, "_").replace(/^\$+/, "_");
      const sanitized = sanitizeFrontmatter(entry, depth + 1);
      if (sanitized !== undefined) out[safeKey] = sanitized;
    }
    return out;
  }

  // Functions, symbols, bigints - nothing a YAML parser produces.
  return undefined;
};

/** A short display label for an external resource node. */
const resourceLabel = (href: string): string => {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol === "mailto:") return url.pathname || href;
    const tail = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    return tail ? `${url.hostname}/${tail}` : url.hostname;
  } catch {
    return href.length > 60 ? `${href.slice(0, 57)}...` : href;
  }
};

/**
 * Builds the graph for one parsed document.
 *
 * Identity rules (all deterministic, so re-processing is idempotent and edges
 * can point at nodes that have not been materialised yet):
 *
 *  - a SECTION is `<projectFqn>::<relativePath>#<anchor-slug>`. Keying on the
 *    anchor rather than the heading hierarchy is what makes a cross-document
 *    link like `docs/guide.md#installing` resolvable without parsing the
 *    target document first. Nesting lives in `parentId`.
 *  - a TOPIC is `topic:<projectFqn>#<slug>`, so every document in the project
 *    that carries the same tag attaches to one shared node.
 *  - a RESOURCE is `resource:<projectFqn>#<normalised-url>`, project-scoped to
 *    match its `parentId` (the project root).
 */
export const emitDocumentGraph = (
  fileNode: ReactorNode,
  outline: DocumentOutline
): DocumentGraph => {
  const data = fileNode.data || {};
  const fqn: string = data.projectFqn;
  const relativePath: string = data.relativePath;
  const filePath: string = data.path;
  const repoPath: string = data.repoPath;
  const projectId = data.projectId;
  const projectRootId = nodeId(fqn);

  const symbols: ReactorNode[] = [];
  const externals: ReactorNode[] = [];
  const edges: ReactorNodeLink[] = [];
  const edgeIds = new Set<number>();
  const externalIds = new Set<number>();

  const pushEdge = (edge: ReactorNodeLink) => {
    if (edge.source === edge.target) return;
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  const addEdge = (
    source: number,
    target: number,
    types: ReactorLinkType[],
    title: string,
    description: string,
    extra?: Record<string, any>
  ) => {
    pushEdge({
      id: linkId(source, target, types[0]),
      source,
      target,
      types,
      title: title?.slice(0, 200),
      description,
      projectId,
      data: extra,
    });
  };

  // ---- SECTION nodes -------------------------------------------------------

  const sectionNodes: ReactorNode[] = [];
  outline.sections.forEach((section, index) => {
    const id = nodeId(symbolLogicalKey(fqn, relativePath, section.slug));
    const parent =
      section.parentIndex !== undefined ? sectionNodes[section.parentIndex] : undefined;
    const parentNode = parent || fileNode;
    const node: ReactorNode = {
      id,
      index: id,
      name: section.title,
      key: appendAncestry(parentNode.key, id),
      type: ReactorNodeType.SECTION,
      description: `Section "${section.title}" (h${section.level}) in ${relativePath}`,
      parentId: parentNode.id,
      providerId: fileNode.providerId,
      nameSpace: fileNode.nameSpace,
      version: fileNode.version,
      source: filePath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: {
        kind: "section",
        slug: section.slug,
        aliases: section.aliases,
        level: section.level,
        line: section.line,
        endLine: section.endLine,
        lines: Math.max(1, section.endLine - section.line + 1),
        relativePath,
        repoPath,
        projectFqn: fqn,
        projectId,
        documentFormat: outline.format,
        /** Sections have no filesystem children to expand. */
        noExpand: true,
      },
    };
    sectionNodes[index] = node;
    symbols.push(node);
  });

  /** The node a reference on `line` originates from: its section, else the file. */
  const sourceFor = (link: DocLink): ReactorNode =>
    link.sectionIndex !== undefined && sectionNodes[link.sectionIndex]
      ? sectionNodes[link.sectionIndex]
      : fileNode;

  /** Section node id for an anchor inside this document, if it exists. */
  const localSectionId = (anchor: string): number | undefined => {
    const wanted = slugify(decodeAnchor(anchor));
    const match = outline.sections.find(
      (s) => s.slug === wanted || (s.aliases || []).includes(wanted)
    );
    return match ? nodeId(symbolLogicalKey(fqn, relativePath, match.slug)) : undefined;
  };

  // ---- TOPIC nodes ---------------------------------------------------------

  const addTopic = (tag: string): number | undefined => {
    const slug = slugify(tag);
    if (!slug) return undefined;
    const id = nodeId(`topic:${fqn}#${slug}`);
    if (!externalIds.has(id)) {
      externalIds.add(id);
      externals.push({
        id,
        index: id,
        name: tag,
        key: appendAncestry(`${projectRootId}`, id),
        type: ReactorNodeType.TOPIC,
        description: `Topic "${tag}"`,
        parentId: projectRootId,
        providerId: fileNode.providerId,
        nameSpace: fileNode.nameSpace,
        version: fileNode.version,
        categories: [],
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: { kind: "topic", slug, label: tag, projectFqn: fqn, projectId, noExpand: true },
      } as ReactorNode);
    }
    return id;
  };

  // ---- RESOURCE nodes ------------------------------------------------------

  const addResource = (href: string): number => {
    const url = normalizeExternalUrl(href);
    const id = nodeId(`resource:${fqn}#${url}`);
    if (!externalIds.has(id)) {
      externalIds.add(id);
      let host: string | undefined;
      let scheme: string | undefined;
      try {
        const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
        host = parsed.hostname || undefined;
        scheme = parsed.protocol.replace(":", "");
      } catch {
        // keep host/scheme undefined for unparseable destinations
      }
      externals.push({
        id,
        index: id,
        name: resourceLabel(url),
        key: appendAncestry(`${projectRootId}`, id),
        type: ReactorNodeType.RESOURCE,
        description: `External resource ${url}`,
        parentId: projectRootId,
        providerId: fileNode.providerId,
        nameSpace: fileNode.nameSpace,
        version: fileNode.version,
        source: url,
        categories: [],
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: {
          kind: "resource",
          url,
          host,
          scheme,
          projectFqn: fqn,
          projectId,
          noExpand: true,
        },
      } as ReactorNode);
    }
    return id;
  };

  // ---- link edges ----------------------------------------------------------

  const emitLink = (link: DocLink) => {
    const source = sourceFor(link);
    const href = link.href;
    const isImage = link.kind === "image";

    // Intra-document anchor: `[see](#setup)`.
    if (href.startsWith("#")) {
      const targetId = localSectionId(href.slice(1));
      if (targetId !== undefined) {
        addEdge(
          source.id,
          targetId,
          [ReactorLinkType.REFERENCE],
          link.label || href,
          `${relativePath} links to ${href}`,
          { anchor: href.slice(1), line: link.line, internal: true }
        );
      }
      return;
    }

    // External destination: URL, mailto, slack, ...
    if (hasScheme(href)) {
      // A code-span never yields a resource - it is a path mention, not a link.
      if (link.kind === "code-span") return;
      const targetId = addResource(href);
      addEdge(
        source.id,
        targetId,
        [isImage ? ReactorLinkType.EMBEDS : ReactorLinkType.REFERENCE],
        link.label || resourceLabel(href),
        `${relativePath} ${isImage ? "embeds" : "links to"} ${href}`,
        { url: normalizeExternalUrl(href), line: link.line, external: true, kind: link.kind }
      );
      return;
    }

    // In-repo destination.
    let resolved = resolveDocumentTarget(href, filePath, repoPath);

    // A path *mentioned* in prose (a code span) is conventionally written from
    // the repository root - "configured in `src/config.ts`" - whereas a real
    // markdown link is always relative to the document. So only mentions get
    // the root-relative second attempt; guessing on real links would invent
    // edges the author did not write.
    if (!resolved && link.kind === "code-span" && !href.startsWith("/")) {
      resolved = resolveDocumentTarget(`/${href}`, filePath, repoPath);
    }

    if (!resolved) return;

    const targetFileId = nodeId(pathLogicalKey(fqn, resolved.relativePath));

    // An anchor addresses a section *inside* the target document. Section ids
    // are anchor-keyed, so this is computable without parsing the target.
    if (resolved.anchor && isDocumentTarget(resolved.relativePath)) {
      const targetSectionId = nodeId(
        symbolLogicalKey(fqn, resolved.relativePath, resolved.anchor)
      );
      addEdge(
        source.id,
        targetSectionId,
        [ReactorLinkType.REFERENCE],
        link.label || href,
        `${relativePath} links to ${resolved.relativePath}#${resolved.anchor}`,
        {
          line: link.line,
          resolved: resolved.relativePath,
          anchor: resolved.anchor,
          kind: link.kind,
        }
      );
      // Also connect the documents themselves, so a file-level view still
      // shows the relationship.
      addEdge(
        source.id,
        targetFileId,
        [ReactorLinkType.REFERENCE],
        link.label || href,
        `${relativePath} links to ${resolved.relativePath}`,
        { line: link.line, resolved: resolved.relativePath, kind: link.kind }
      );
      return;
    }

    if (isImage || isAssetTarget(resolved.relativePath)) {
      addEdge(
        source.id,
        targetFileId,
        [ReactorLinkType.EMBEDS],
        link.label || path.basename(resolved.relativePath),
        `${relativePath} embeds ${resolved.relativePath}`,
        { line: link.line, resolved: resolved.relativePath, kind: link.kind }
      );
      return;
    }

    // A document pointing at source, config or a folder *documents* it. This is
    // the edge that ties a README to the code it describes.
    if (isCodeTarget(resolved.relativePath) || resolved.isDirectory) {
      addEdge(
        source.id,
        targetFileId,
        [ReactorLinkType.DOCUMENTS, ReactorLinkType.REFERENCE],
        link.label || resolved.relativePath,
        `${relativePath} documents ${resolved.relativePath}`,
        {
          line: link.line,
          resolved: resolved.relativePath,
          kind: link.kind,
          targetKind: resolved.isDirectory ? "folder" : "file",
        }
      );
      return;
    }

    addEdge(
      source.id,
      targetFileId,
      [ReactorLinkType.REFERENCE],
      link.label || resolved.relativePath,
      `${relativePath} links to ${resolved.relativePath}`,
      { line: link.line, resolved: resolved.relativePath, kind: link.kind }
    );
  };

  outline.links.forEach(emitLink);

  // Frontmatter cross-references behave exactly like body links.
  const frontmatterRefs = collectFrontmatterRefs(outline);
  frontmatterRefs.forEach((href) =>
    emitLink({ label: href, href, line: 1, kind: "link" })
  );

  // ---- topic edges ---------------------------------------------------------

  outline.tags.forEach((tag) => {
    const topicId = addTopic(tag);
    if (topicId === undefined) return;
    addEdge(
      fileNode.id,
      topicId,
      [ReactorLinkType.MENTIONS],
      tag,
      `${relativePath} is about "${tag}"`,
      { tag, source: "frontmatter" }
    );
  });

  // ---- file node patch ----------------------------------------------------

  const codeLanguages = Array.from(
    new Set(outline.codeBlocks.map((b) => b.language).filter((l): l is string => !!l))
  ).sort();

  const description = outline.title
    ? `${outline.title} (${relativePath})`
    : `Document ${relativePath}`;

  return {
    symbols,
    externals,
    edges,
    filePatch: {
      description,
      data: {
        kind: "document",
        documentFormat: outline.format,
        documentTitle: outline.title,
        frontmatter: outline.frontmatter
          ? (sanitizeFrontmatter(outline.frontmatter) as Record<string, any>)
          : undefined,
        tags: outline.tags,
        headings: outline.sections.map((s) => ({
          title: s.title,
          level: s.level,
          slug: s.slug,
          line: s.line,
        })),
        codeLanguages,
        documentMetrics: outline.metrics,
        ...(outline.warnings.length ? { documentWarnings: outline.warnings } : {}),
      },
    },
  };
};

/**
 * Frontmatter fields that name other documents. Docs sites commonly express
 * "see also" relationships there rather than in the body.
 */
const FRONTMATTER_REF_FIELDS = [
  "related",
  "related_docs",
  "relatedDocs",
  "see_also",
  "seeAlso",
  "links",
  "references",
];

const collectFrontmatterRefs = (outline: DocumentOutline): string[] => {
  const fm = outline.frontmatter;
  if (!fm) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === "string") {
      const href = value.trim();
      if (href && !seen.has(href)) {
        seen.add(href);
        out.push(href);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    // `{ title, url }` entries are common in docs frontmatter.
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      push(record.url ?? record.href ?? record.path);
    }
  };
  FRONTMATTER_REF_FIELDS.forEach((field) => push(fm[field]));
  return out;
};

export default emitDocumentGraph;
