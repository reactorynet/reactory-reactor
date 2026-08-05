import fs from "fs";
import path from "path";
import { service } from "application/decorators";
import BaseProjectProcessor from "../BaseProjectProcessor";
import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { documentFormatFor } from "../../graph/documents";

/**
 * Directories that conventionally hold a project's documentation. Scanned (one
 * level deep) so a project whose root holds only `docs/` is still detected as a
 * documentation project.
 */
const DOC_DIRECTORIES = [
  "docs",
  "doc",
  "documentation",
  "wiki",
  "adr",
  "rfcs",
  "rfc",
  "guides",
  "handbook",
  "content",
  "pages",
  "_posts",
];

/** Files whose presence marks a documentation *site* rather than loose notes. */
const DOC_SITE_MARKERS = [
  "mkdocs.yml",
  "mkdocs.yaml",
  "docusaurus.config.js",
  "docusaurus.config.ts",
  "book.toml",
  "_config.yml",
  "antora.yml",
  ".vitepress",
  "docsify.js",
];

/** Cap on entries read per directory during detection. */
const DETECT_SCAN_LIMIT = 400;

/**
 * Processor for documentation: prose-first repositories (handbooks, ADR
 * archives, docs sites) and the documentation inside code projects.
 *
 * The document *graphing* itself lives in `services/graph/documents` and is
 * wired into BaseProjectProcessor, so every processor outlines the documents it
 * walks. What this processor adds is:
 *
 *  - detection, so a docs-only repository is recognised as a project at all,
 *  - project typing (`documentation` + the dialects present),
 *  - a document-only file claim, so when it runs alongside a language processor
 *    on a hybrid project it contributes documents without taking ownership of
 *    that project's source nodes.
 */
@service({
  name: "MarkdownProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description:
    "Processor for documentation projects (markdown, reStructuredText, AsciiDoc, plain text) and the documentation inside code projects",
  id: "reactor.MarkdownProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
export class MarkdownProjectProcessor extends BaseProjectProcessor {
  nameSpace: string = "reactor";
  name: string = "MarkdownProjectProcessor";
  version: string = "1.0.0";

  protected iconKey(): string | null {
    return "markdown";
  }

  /**
   * On a hybrid project only documents are claimed: this processor runs beside
   * a language processor, and restating every source file node under its own
   * providerId would stop the tree expanding symbols for those files.
   *
   * On a documentation-only project nothing else walks the tree, so everything
   * is claimed - otherwise an image a document embeds, or a config file it
   * links to, would have no node for those edges to land on.
   */
  protected claimsFile(
    fileNode: ReactorNode,
    project: Partial<IReactorProject>
  ): boolean {
    if (this.isDocument(fileNode?.data?.path, fileNode?.data?.language)) return true;
    return !this.hasPeerProcessor(project);
  }

  /**
   * True when the project contains documents. Looks at the repository root and
   * one level into the conventional documentation directories - a docs project
   * frequently has nothing but a `docs/` folder at its root.
   */
  supportsProject(project: Partial<IReactorProject>): boolean {
    return this.documentFormats(project).length > 0;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    const formats = this.documentFormats(project);
    if (formats.length === 0) return [];

    const types: KnownReactorProjectTypes[] = ["documentation"];
    const byFormat: Record<string, KnownReactorProjectTypes> = {
      markdown: "markdown",
      mdx: "mdx",
      asciidoc: "asciidoc",
      restructuredtext: "restructuredtext",
      text: "plaintext",
    };
    formats.forEach((format) => {
      const type = byFormat[format];
      if (type && !types.includes(type)) types.push(type);
    });
    return types;
  }

  /**
   * The document dialects found in the project, in discovery order. Empty when
   * the project holds no documents.
   */
  private documentFormats(project: Partial<IReactorProject>): string[] {
    const root = project?.repoPath;
    if (!root) return [];

    const formats = new Set<string>();

    const scan = (dir: string, descend: boolean): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirectories: string[] = [];
      for (const entry of entries.slice(0, DETECT_SCAN_LIMIT)) {
        if (entry.isDirectory()) {
          if (this.ignoredDirectories.has(entry.name)) continue;
          subdirectories.push(path.join(dir, entry.name));
          continue;
        }
        // A docs-site config marks the project as documentation even before any
        // document is seen (the content may live deeper than we scan).
        if (DOC_SITE_MARKERS.includes(entry.name)) formats.add("markdown");
        const format = documentFormatFor(entry.name);
        if (format) formats.add(format);
      }
      if (!descend) return;
      for (const subdirectory of subdirectories) {
        // Only conventional documentation directories are descended into, so
        // detection stays cheap on large repositories.
        if (DOC_DIRECTORIES.includes(path.basename(subdirectory).toLowerCase())) {
          scan(subdirectory, false);
        }
      }
    };

    scan(root, true);
    return Array.from(formats);
  }
}

export default MarkdownProjectProcessor;
