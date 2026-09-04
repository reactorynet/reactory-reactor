import fs from "fs";
import path from "path";
import ignore from "ignore";
import { createHash, randomUUID } from "crypto";
import Reactory from "@reactorynet/reactory-core";
import {
  IReactorProject,
  IReactorProjectFileSpec,
  IProjectProcessor,
  KnownReactorProjectTypes,
  GraphProcessMetrics,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorLinkType,
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import { PagingRequest } from "@reactory/server-core/database/types";
import Hash from "@reactory/server-core/utils/hash";
import {
  appendAncestry,
  canonicalProjectId,
  linkId,
  nodeId,
  normalizeRelative,
  pathLogicalKey,
  projectFqn,
} from "../graph/GraphIdentity";
import BaseGraphProvider from "../ReactorGraphProviders/BaseGraphProvider";
import {
  DOCUMENT_LANGUAGES,
  DocumentGraphOptions,
  SymbolIndex,
  analyseDocumentFile,
  buildSymbolIndex,
  documentFormatFor,
} from "../graph/documents";

/**
 * The result of a deep analysis of a single source file: the symbol nodes it
 * contains, external dependency nodes it references, and the edges (imports,
 * references) it originates.
 */
export interface FileAnalysisResult {
  symbols: ReactorNode[];
  externals: ReactorNode[];
  edges: ReactorNodeLink[];
  /**
   * Optional enrichment for the analysed file's own node, merged by process().
   * Document analysis uses it to lift a document's title, frontmatter, tags and
   * outline onto the file node so the node is meaningful without expanding it.
   */
  filePatch?: {
    description?: string;
    data?: Record<string, any>;
  };
}

/** Maximum characters of file content stored on a searchable. */
const MAX_SEARCHABLE_CONTENT = 100_000;

/** Computes SHA-256 hex hash of file content. */
export function fileContentHash(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Languages a processor may deep-analyse during process(). */
const ANALYSABLE_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "java",
  "csharp",
  "kotlin",
  "yaml",
  "terraform",
  // Document dialects - handled by the base document analyzer for every
  // processor, so documentation in a code project is graphed too.
  ...DOCUMENT_LANGUAGES,
]);

/**
 * Payload attached to every folder/file node the base walker produces. Carrying
 * repoPath + projectFqn on the node means we can expand a child's children (and
 * later analyse a file) without re-fetching the project from Mongo.
 */
export interface TreeNodeData {
  path: string; // absolute filesystem path
  relativePath: string; // path relative to repoPath (posix)
  repoPath: string; // project root, propagated to every descendant
  projectFqn: string;
  projectId?: string | number;
  kind:
    | "folder"
    | "file"
    | "symbol"
    | "submodule"
    | "symlink"
    /** A prose document the document analyzers can outline. */
    | "document"
    /** A heading-delimited section of a document. */
    | "section"
    /** A subject a document is about (frontmatter tag, keyword). */
    | "topic"
    /** An out-of-repo resource a document points at. */
    | "resource";
  language?: string;
  /** Symlink metadata — present when kind is 'symlink'. */
  symlink?: {
    target: string;
    relativeTarget?: string;
    resolvedNodeId?: number;
    broken: boolean;
  };
  /** True for nodes that must never expand children (cycle guard). */
  noExpand?: boolean;
  [key: string]: any;
}

/** Filesystem classification of a directory entry, symlink-aware. */
export interface EntryClassification {
  /** True when the entry (or a symlink's target) is a directory. */
  isDir: boolean;
  isSymlink: boolean;
  /** True when a symlink's target cannot be resolved (ENOENT/ELOOP). */
  broken: boolean;
  /** Canonical (realpath) target of a symlink. */
  realTarget?: string;
  /** True when the symlink target resolves inside the repo. */
  targetInRepo: boolean;
  /** Repo-relative posix path of the target when in-repo. */
  relativeTarget?: string;
}

/** A symlink discovered during the batch file walk. */
interface SymlinkRecord {
  fullPath: string;
  entryName: string;
  classification: EntryClassification;
}

/**
 * BaseProjectProcessor provides a language-agnostic implementation of the
 * IProjectProcessor contract:
 *
 *  - a deterministic project root node,
 *  - generic, lazy folder/file tree expansion via getChildrenForNode,
 *  - a default icon attribute,
 *  - generic file discovery for process()/getFileSpecs.
 *
 * Concrete processors only need to declare the language-specific bits
 * (supportsProject, getProjectTypes, iconKey) and may override analyseFile()
 * to contribute symbol nodes + edges (see the TypeScript analyzer wiring).
 */
export abstract class BaseProjectProcessor
  extends BaseGraphProvider
  implements IProjectProcessor
{
  /** Directory names that are never descended into. */
  protected ignoredDirectories = new Set<string>([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".turbo",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".gradle",
    "bin",
    "obj",
    "target",
  ]);

  /** File names that are ignored during tree expansion. */
  protected ignoredFiles = new Set<string>([".DS_Store", "Thumbs.db"]);

  private gitignoreCache: Record<string, any> = {};

  protected getGitignore(repoPath: string): any {
    if (!repoPath) return null;
    let realRepoPath = repoPath;
    try {
      realRepoPath = fs.realpathSync(repoPath);
    } catch {
      // fallback to original if realpath fails
    }
    if (this.gitignoreCache[realRepoPath] !== undefined) {
      return this.gitignoreCache[realRepoPath];
    }
    const gitignorePath = path.join(realRepoPath, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, "utf8");
        const ig = ignore().add(content);
        this.gitignoreCache[realRepoPath] = ig;
        return ig;
      } catch (err) {
        this.context.warn(`Failed to read .gitignore at ${realRepoPath}: ${(err as Error).message}`);
      }
    }
    this.gitignoreCache[realRepoPath] = null;
    return null;
  }

  protected isPathIgnored(repoPath: string, fullPath: string, isDirectory: boolean): boolean {
    let realRepoPath = repoPath;
    let realFullPath = fullPath;
    try {
      realRepoPath = fs.realpathSync(repoPath);
    } catch {
      // fallback
    }
    try {
      realFullPath = fs.realpathSync(fullPath);
    } catch {
      // fallback
    }
    const ig = this.getGitignore(realRepoPath);
    if (!ig) return false;
    
    const relativePath = path.relative(realRepoPath, realFullPath).split(path.sep).join("/");
    const checkPath = relativePath + (isDirectory ? "/" : "");
    return ig.ignores(checkPath);
  }

  // ---- Abstract / overridable language hooks -------------------------------

  /**
   * Deep-analyse a FILE node into symbol nodes, external dependency nodes and
   * edges. Both interactive tree expansion (analyseFile) and batch processing
   * (process) build on this.
   *
   * The default handles *documents* (markdown, reStructuredText, AsciiDoc,
   * plain text): sections, cross-document links, doc-to-code references,
   * embedded assets and frontmatter topics. Language processors override this
   * for their own sources (e.g. NodeJS wires in the TypeScript AST analyzer)
   * and should delegate here for anything they do not handle, so that a code
   * project's documentation is graphed as well as its code.
   */
  protected async analyseFileFull(
    fileNode: ReactorNode
  ): Promise<FileAnalysisResult> {
    const { language, path: filePath } = fileNode?.data || {};
    if (this.isDocument(filePath, language)) {
      return analyseDocumentFile(fileNode, this.context);
    }
    return { symbols: [], externals: [], edges: [] };
  }

  /** True when a file is a document the base analyzer can outline. */
  protected isDocument(filePath?: string, language?: string): boolean {
    if (language && DOCUMENT_LANGUAGES.has(language)) return true;
    return !!filePath && documentFormatFor(filePath) !== null;
  }

  /**
   * Whether process() should emit a node for this file.
   *
   * Default: everything the walker found, which is what a project's primary
   * processor wants. A *supplementary* processor - one that runs alongside
   * others on a hybrid project - narrows this to the files it actually
   * understands, so it does not restate (and take ownership of) nodes another
   * processor owns. Node ids are deterministic, so the only thing at stake is
   * which processor's `providerId` lands on the node, and therefore which
   * analyzer expands it in the tree.
   */
  protected claimsFile(
    _fileNode: ReactorNode,
    _project: Partial<IReactorProject>
  ): boolean {
    return true;
  }

  /**
   * True when another processor is configured for this project, i.e. this one
   * is running as a supplement rather than as the project's primary processor.
   * The generic file fallback does not count as a peer.
   */
  protected hasPeerProcessor(project: Partial<IReactorProject>): boolean {
    const self = this.fqn();
    return (project?.processors || []).some(
      (config) =>
        !!config?.processor &&
        config.processor !== self &&
        config.processor !== "reactor.FileProjectProcessor@1.0.0"
    );
  }

  /**
   * Child nodes for a FILE node during interactive tree browsing (symbols only;
   * edges are persisted during process()). Caches each symbol node.
   */
  protected async analyseFile(fileNode: ReactorNode): Promise<ReactorNode[]> {
    const { symbols } = await this.analyseFileFull(fileNode);
    await Promise.all(
      symbols.map((n) => this.context.setValue(`REACTOR_NODE_${n.id}`, n))
    );
    return symbols;
  }

  /**
   * Coarse language classification from a file extension. Document dialects
   * resolve through documentFormatFor(), which also recognises extension-less
   * conventions (README, CHANGELOG, LICENSE).
   */
  protected languageForFile(fileName: string): string | undefined {
    const documentFormat = documentFormatFor(fileName);
    if (documentFormat) return documentFormat;
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".py": "python",
      ".java": "java",
      ".kt": "kotlin",
      ".kts": "kotlin",
      ".cs": "csharp",
      ".sql": "tsql",
      ".go": "go",
      ".rb": "ruby",
      ".php": "php",
      ".json": "json",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".tf": "terraform",
      ".tfvars": "terraform",
    };
    return map[ext];
  }

  // ---- Node construction ---------------------------------------------------

  private isRootNode(node: Partial<ReactorNode>): boolean {
    return node.parentId === undefined || node.parentId === null;
  }

  private repoPathOf(node: Partial<ReactorNode>): string | undefined {
    return node?.data?.repoPath;
  }

  private fqnOf(node: Partial<ReactorNode>): string {
    return node?.data?.projectFqn || projectFqn(node?.data || {});
  }

  /**
   * Classifies a directory entry, resolving symlinks to their real target.
   * A symlink's `isDir` reflects the target's kind (false when broken).
   */
  protected classifyEntry(
    entry: fs.Dirent,
    fullPath: string,
    realRepoPath: string
  ): EntryClassification {
    if (!entry.isSymbolicLink()) {
      return {
        isDir: entry.isDirectory(),
        isSymlink: false,
        broken: false,
        targetInRepo: false,
      };
    }
    try {
      // statSync follows the link — throws on broken targets and ELOOP cycles.
      const stat = fs.statSync(fullPath);
      const realTarget = fs.realpathSync(fullPath);
      const targetInRepo =
        !!realRepoPath &&
        (realTarget === realRepoPath ||
          realTarget.startsWith(realRepoPath + path.sep));
      return {
        isDir: stat.isDirectory(),
        isSymlink: true,
        broken: false,
        realTarget,
        targetInRepo,
        relativeTarget: targetInRepo
          ? normalizeRelative(path.relative(realRepoPath, realTarget))
          : undefined,
      };
    } catch {
      return { isDir: false, isSymlink: true, broken: true, targetInRepo: false };
    }
  }

  private makeTreeNode(
    parent: Partial<ReactorNode>,
    entryName: string,
    fullPath: string,
    relativePath: string,
    classification: EntryClassification
  ): ReactorNode {
    const fqn = this.fqnOf(parent);
    const id = nodeId(pathLogicalKey(fqn, relativePath));
    const { isDir: isDirectory, isSymlink } = classification;
    const isSubmodule =
      isDirectory && !isSymlink && fs.existsSync(path.join(fullPath, ".git"));
    const language =
      isDirectory || isSymlink ? undefined : this.languageForFile(entryName);
    const isDocument = !isDirectory && !isSymlink && this.isDocument(entryName, language);
    const data: TreeNodeData = {
      path: fullPath,
      relativePath,
      repoPath: this.repoPathOf(parent),
      projectFqn: fqn,
      projectId: parent?.data?.projectId,
      kind: isSymlink
        ? "symlink"
        : isSubmodule
        ? "submodule"
        : isDirectory
        ? "folder"
        : isDocument
        ? "document"
        : "file",
      language,
    };

    if (isSymlink) {
      data.symlink = {
        target: classification.realTarget || "",
        relativeTarget: classification.relativeTarget,
        resolvedNodeId:
          classification.targetInRepo && classification.relativeTarget
            ? nodeId(pathLogicalKey(fqn, classification.relativeTarget))
            : undefined,
        broken: classification.broken,
      };
      // Never expand children through a link node — the real target (reachable
      // via the SYMLINK edge) expands normally. This is the lazy-tree cycle guard.
      data.noExpand = true;
    }

    const describe = isSymlink
      ? `Symlink ${relativePath}${classification.relativeTarget ? ` -> ${classification.relativeTarget}` : classification.broken ? " (broken)" : ""}`
      : `${isSubmodule ? "Submodule" : isDirectory ? "Folder" : isDocument ? "Document" : "File"} ${relativePath}`;

    return {
      id,
      index: id,
      name: entryName,
      key: appendAncestry(parent.key, id),
      type: isDirectory
        ? ReactorNodeType.FOLDER
        : isDocument
        ? ReactorNodeType.DOCUMENT
        : ReactorNodeType.FILE,
      description: describe,
      parentId: parent.id,
      providerId: parent.providerId,
      nameSpace: parent.nameSpace,
      version: parent.version,
      source: fullPath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data,
    };
  }

  /**
   * Builds a FOLDER node for an intermediate path segment during batch process().
   * Mirrors the folder branch of makeTreeNode so that batch + interactive
   * agree on id / type / kind / parentId / key.
   */
  private makeFolderNode(
    parent: Partial<ReactorNode>,
    segment: string,
    fullPath: string,
    relativePath: string
  ): ReactorNode {
    const fqn = this.fqnOf(parent);
    const id = nodeId(pathLogicalKey(fqn, relativePath));
    const isSubmodule = fs.existsSync(path.join(fullPath, ".git"));
    const data: TreeNodeData = {
      path: fullPath,
      relativePath,
      repoPath: this.repoPathOf(parent),
      projectFqn: fqn,
      projectId: parent?.data?.projectId,
      kind: isSubmodule ? "submodule" : "folder",
    };
    return {
      id,
      index: id,
      name: segment,
      key: appendAncestry(parent.key, id),
      type: ReactorNodeType.FOLDER,
      description: `${isSubmodule ? "Submodule" : "Folder"} ${relativePath}`,
      parentId: parent.id,
      providerId: parent.providerId,
      nameSpace: parent.nameSpace,
      version: parent.version,
      source: fullPath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data,
    };
  }

  /**
   * Ensure the chain of FOLDER nodes for a file's parent directories exists.
   * Returns the immediate parent folder (or root) for the file.
   * Uses a Map for de-duplication within a single process run.
   */
  private ensureFolderChain(
    relativeFilePath: string,
    root: Partial<ReactorNode>,
    repoPath: string,
    folderByRel: Map<string, ReactorNode>,
    nodes: Partial<ReactorNode>[]
  ): Partial<ReactorNode> {
    const parts = normalizeRelative(relativeFilePath).split("/").slice(0, -1); // drop filename
    let parent: Partial<ReactorNode> = root;
    let acc: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      acc.push(part);
      const rel = acc.join("/");
      if (folderByRel.has(rel)) {
        parent = folderByRel.get(rel)!;
        continue;
      }
      const full = path.join(repoPath, rel);
      const folder = this.makeFolderNode(parent, part, full, rel);
      folderByRel.set(rel, folder);
      nodes.push(folder);
      parent = folder;
    }
    return parent;
  }

  // ---- Tree expansion ------------------------------------------------------

  async getChildrenForNode(
    node: Partial<ReactorNode>,
    _treeKey: string,
    filter: string,
    paging: PagingRequest
  ): Promise<ReactorNode[]> {
    const { context } = this;

    // Symlink (and other no-expand) nodes never expand through the link — the
    // real target node expands normally. Cycle guard for the lazy tree.
    if (node?.data?.noExpand === true) return [];

    // FILE nodes expand into symbols, DOCUMENT nodes into their sections.
    if (node.type === ReactorNodeType.FILE || node.type === ReactorNodeType.DOCUMENT) {
      try {
        return await this.analyseFile(node as ReactorNode);
      } catch (err) {
        context.warn(
          `analyseFile failed for ${node?.data?.path}: ${(err as Error).message}`
        );
        return [];
      }
    }

    const repoPath = this.repoPathOf(node);
    if (!repoPath) return [];

    // Base directory: the project root for the root node, else the folder path.
    const baseDir = this.isRootNode(node)
      ? repoPath
      : node.type === ReactorNodeType.FOLDER
      ? node?.data?.path
      : undefined;

    if (!baseDir || !fs.existsSync(baseDir)) return [];

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (err) {
      context.warn(`Unable to read directory ${baseDir}: ${(err as Error).message}`);
      return [];
    }

    let realRepoPath = repoPath;
    try {
      realRepoPath = fs.realpathSync(repoPath);
    } catch {
      // fallback to the raw path
    }

    const children: ReactorNode[] = [];
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      const classification = this.classifyEntry(entry, fullPath, realRepoPath);
      const isDir = classification.isDir && !classification.isSymlink;
      if (isDir && this.ignoredDirectories.has(entry.name)) continue;
      if (!isDir && !classification.isSymlink && this.ignoredFiles.has(entry.name)) continue;
      // The filter only narrows files, never folders (so the tree stays navigable).
      if (!isDir && !classification.isSymlink && filter && !entry.name.match(filter)) continue;

      if (this.isPathIgnored(repoPath, fullPath, isDir)) continue;

      const relativePath = path
        .relative(repoPath, fullPath)
        .split(path.sep)
        .join("/");
      children.push(this.makeTreeNode(node, entry.name, fullPath, relativePath, classification));
    }

    // Stable ordering: folders first, then files, alphabetical within each.
    children.sort((a, b) => {
      const aDir = a.type === ReactorNodeType.FOLDER ? 0 : 1;
      const bDir = b.type === ReactorNodeType.FOLDER ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });

    const paged = this.applyPaging(children, paging);
    await Promise.all(
      paged.map((c) => this.context.setValue(`REACTOR_NODE_${c.id}`, c))
    );
    return paged;
  }

  // ---- File discovery ------------------------------------------------------

  /**
   * Recursively lists files in the project honouring ignore rules and optional
   * pathSpecs. Bounded by `maxFiles` to avoid pathological repos.
   */
  protected listFiles(
    project: Partial<IReactorProject>,
    maxFiles = 20000,
    symlinks?: SymlinkRecord[]
  ): Partial<IReactorProjectFileSpec>[] {
    const specs: Partial<IReactorProjectFileSpec>[] = [];
    const roots: { dir: string; type: string; filter?: string }[] = [];
    // Real (canonical) directories already walked — guards against symlink
    // cycles and double-walking directories reachable via multiple links.
    const visitedRealDirs = new Set<string>();

    const realRepoPath = project.repoPath ? fs.realpathSync(project.repoPath) : "";

    if (project.pathSpecs && project.pathSpecs.length > 0) {
      project.pathSpecs.forEach((ps) =>
        roots.push({
          dir: path.isAbsolute(ps.path)
            ? ps.path
            : path.join(realRepoPath || "", ps.path),
          type: ps.type,
          filter: ps.filter,
        })
      );
    } else if (realRepoPath) {
      roots.push({ dir: realRepoPath, type: "file" });
    }

    const ig = this.getGitignore(realRepoPath);

    const walk = (
      dir: string,
      type: string,
      filter?: string,
      parentIg?: any,
      gitignoreDir?: string
    ) => {
      if (specs.length >= maxFiles) return;

      let currentIg = parentIg;
      let currentGitignoreDir = gitignoreDir;

      let realDir = dir;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        // fallback
      }

      if (visitedRealDirs.has(realDir)) return;
      visitedRealDirs.add(realDir);

      const gitignorePath = path.join(realDir, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        try {
          const content = fs.readFileSync(gitignorePath, "utf8");
          currentIg = ignore().add(content);
          currentGitignoreDir = realDir;
        } catch {
          // ignore
        }
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(realDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (specs.length >= maxFiles) return;
        const full = path.join(realDir, entry.name);

        // Symlinks are recorded (node + resolution edge material) but never
        // recursed or spec'd through the link: in-repo targets are indexed at
        // their real location; out-of-repo targets stay metadata only.
        if (entry.isSymbolicLink()) {
          if (symlinks) {
            symlinks.push({
              fullPath: full,
              entryName: entry.name,
              classification: this.classifyEntry(entry, full, realRepoPath),
            });
          }
          continue;
        }

        let realFull = full;
        try {
          realFull = fs.realpathSync(full);
        } catch {
          // fallback
        }
        const isDirectory = entry.isDirectory();

        if (isDirectory) {
          if (this.ignoredDirectories.has(entry.name)) continue;

          const relToRoot = path.relative(realRepoPath || "", realFull).split(path.sep).join("/");
          const checkPath = relToRoot + "/";
          if (ig && ig.ignores(checkPath)) continue;

          if (currentIg && currentGitignoreDir && currentGitignoreDir !== realRepoPath) {
            const relToGitignore = path.relative(currentGitignoreDir, realFull).split(path.sep).join("/");
            if (currentIg.ignores(relToGitignore + "/")) continue;
          }

          // Check if it's a submodule or nested repository
          const dotGitPath = path.join(realFull, ".git");
          if (fs.existsSync(dotGitPath)) {
            if (!project.submodules) {
              project.submodules = [];
            }
            if (!project.submodules.includes(realFull)) {
              project.submodules.push(realFull);
            }
            continue;
          }

          walk(realFull, type, filter, currentIg, currentGitignoreDir);
        } else {
          if (this.ignoredFiles.has(entry.name)) continue;

          const relToRoot = path.relative(realRepoPath || "", realFull).split(path.sep).join("/");
          if (ig && ig.ignores(relToRoot)) continue;

          if (currentIg && currentGitignoreDir && currentGitignoreDir !== realRepoPath) {
            const relToGitignore = path.relative(currentGitignoreDir, realFull).split(path.sep).join("/");
            if (currentIg.ignores(relToGitignore)) continue;
          }

          if (filter && !entry.name.match(filter)) continue;

          specs.push({
            id: Hash(`${realRepoPath}-${realFull}-${type}`),
            type,
            path: realFull,
            content: "<NOTREAD>",
          });
        }
      }
    };

    roots.forEach((r) => {
      let realRDir = r.dir;
      try {
        if (fs.existsSync(r.dir)) {
          realRDir = fs.realpathSync(r.dir);
        }
      } catch {
        // fallback
      }
      if (fs.existsSync(realRDir)) walk(realRDir, r.type, r.filter, ig, realRepoPath);
      else this.context.warn(`Path ${r.dir} does not exist`);
    });

    return specs;
  }

  getFileSpecs(
    project: Partial<IReactorProject>
  ): Partial<IReactorProjectFileSpec>[] {
    return this.listFiles(project);
  }

  async setFileSpecs(
    project: Partial<IReactorProject>,
    specs: Partial<IReactorProjectFileSpec>[]
  ): Promise<Partial<IReactorProject>> {
    return { ...project, files: specs as IReactorProjectFileSpec[] };
  }

  // ---- Processing / indexing ----------------------------------------------

  /**
   * Builds a FILE (or DOCUMENT) node parented to the *immediate* parent
   * (folder or root). Used by batch process(). Must agree with makeTreeNode
   * on id, type and kind so the batch and interactive paths produce one node,
   * not two. File ids remain based on full relativePath (unchanged).
   */
  private fileNodeForProcess(
    parent: Partial<ReactorNode>,
    project: Partial<IReactorProject>,
    absPath: string,
    contentHash?: string
  ): ReactorNode {
    const fqn = projectFqn(project);
    const relativePath = normalizeRelative(
      path.relative(project.repoPath || "", absPath)
    );
    const id = nodeId(pathLogicalKey(fqn, relativePath));
    const language = this.languageForFile(absPath);
    const isDocument = this.isDocument(absPath, language);
    return {
      id,
      index: id,
      name: path.basename(absPath),
      key: appendAncestry(parent.key, id),
      type: isDocument ? ReactorNodeType.DOCUMENT : ReactorNodeType.FILE,
      description: `${isDocument ? "Document" : "File"} ${relativePath}`,
      parentId: parent.id,
      providerId: this.fqn(),
      nameSpace: project.nameSpace,
      version: project.version,
      source: absPath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      contentHash,
      created: new Date(),
      updated: new Date(),
      data: {
        path: absPath,
        relativePath,
        repoPath: project.repoPath,
        projectFqn: fqn,
        projectId: project.id,
        kind: isDocument ? "document" : "file",
        language,
      },
    };
  }

  /** Builds a symlink node parented to the *immediate* parent (folder or root). */
  private symlinkNodeForProcess(
    parent: Partial<ReactorNode>,
    project: Partial<IReactorProject>,
    record: SymlinkRecord
  ): ReactorNode {
    const fqn = projectFqn(project);
    let realRepoPath = project.repoPath || "";
    try {
      realRepoPath = fs.realpathSync(project.repoPath || "");
    } catch {
      // fallback
    }
    const relativePath = normalizeRelative(
      path.relative(realRepoPath, record.fullPath)
    );
    const id = nodeId(pathLogicalKey(fqn, relativePath));
    const { classification } = record;
    const resolvedNodeId =
      classification.targetInRepo && classification.relativeTarget
        ? nodeId(pathLogicalKey(fqn, classification.relativeTarget))
        : undefined;

    return {
      id,
      index: id,
      name: record.entryName,
      key: appendAncestry(parent.key, id),
      // The link node keeps its target's natural type; broken links are FILE.
      type: classification.isDir ? ReactorNodeType.FOLDER : ReactorNodeType.FILE,
      description: `Symlink ${relativePath}${classification.relativeTarget ? ` -> ${classification.relativeTarget}` : classification.broken ? " (broken)" : ""}`,
      parentId: parent.id,
      providerId: this.fqn(),
      nameSpace: project.nameSpace,
      version: project.version,
      source: record.fullPath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: {
        path: record.fullPath,
        relativePath,
        repoPath: project.repoPath,
        projectFqn: fqn,
        projectId: project.id,
        kind: "symlink",
        symlink: {
          target: classification.realTarget || "",
          relativeTarget: classification.relativeTarget,
          resolvedNodeId,
          broken: classification.broken,
        },
        noExpand: true,
      } as TreeNodeData,
    };
  }

  private buildSearchable(
    project: Partial<IReactorProject>,
    fileSpec: Partial<IReactorProjectFileSpec>,
    existingContent?: string | null
  ): Reactory.Models.ISearchable | null {
    try {
      const content =
        existingContent !== undefined && existingContent !== null
          ? existingContent
          : fs.readFileSync(fileSpec.path, "utf-8");
      const lines = content.split("\n");
      const fqn = projectFqn(project);
      const relativePath = normalizeRelative(
        path.relative(project.repoPath || "", fileSpec.path)
      );
      const logicalKey = pathLogicalKey(fqn, relativePath);
      const graphNodeId = nodeId(logicalKey);
      return {
        id: logicalKey,
        nodeId: graphNodeId,
        name: `${fileSpec.type}_${relativePath}`,
        nameSpace: project.nameSpace,
        version: project.version,
        source: content.slice(0, MAX_SEARCHABLE_CONTENT),
        path: relativePath,
        relativePath,
        metrics: [{ unit: "lines", value: lines.length, name: "Line Count" }],
        type: { id: fileSpec.type, name: fileSpec.type },
      } as Reactory.Models.ISearchable;
    } catch {
      return null;
    }
  }

  /** Upserts nodes and edges by their deterministic ids (idempotent). */
  /**
   * Full pipeline for a project: discover files, build the project root + file
   * + symbol + external nodes, resolve edges, persist the graph, and index file
   * contents for search. Raw folder browsing remains lazy; only analysed
   * artifacts are persisted.
   *
   * options.runId — shared across processors for a single catalog run so GC does not
   *   wipe sibling processor output. If omitted a fresh UUID is generated.
   * options.skipGc — when true, do not run project-scoped GC after persist (orchestrator
   *   will call GC once after all processors for a shared runId).
   * options.forceFull — when true, bypasses content hash check and re-analyses all files.
   */
  async process(
    project: Partial<IReactorProject>,
    options?: { runId?: string; skipGc?: boolean; forceFull?: boolean; linkDocMentions?: boolean }
  ): Promise<Partial<IReactorProject>> {
    const startTime = Date.now();
    let errorCount = 0;
    const byLanguage: Record<string, number> = {};
    const next = { ...project };
    const projectId = canonicalProjectId(next);
    if (projectId) {
      next.id = projectId as any;
    }
    // Canonicalize the repo path so it agrees with the realpath'd file paths
    // the walker produces — otherwise path.relative degrades to ../.. walks
    // and analyzers drop resolved in-repo edges (e.g. /var vs /private/var
    // on macOS).
    if (next.repoPath) {
      try {
        next.repoPath = fs.realpathSync(next.repoPath);
      } catch {
        // keep the raw path — listFiles guards missing paths itself
      }
    }
    const symlinkRecords: SymlinkRecord[] = [];
    const fileSpecs = this.listFiles(next, 20000, symlinkRecords);
    next.files = fileSpecs as IReactorProjectFileSpec[];

    const root = await this.getProjectNode(next);
    const nodes: Partial<ReactorNode>[] = [root];
    const externals = new Map<number, ReactorNode>();
    const edges: ReactorNodeLink[] = [];
    const searchables: Reactory.Models.ISearchable[] = [];

    // Folder nodes for batch process() — ensures parity with makeTreeNode ancestry
    const folderByRel = new Map<string, ReactorNode>();

    const prevById = await this.loadPreviousNodes(next);
    let analysedCount = 0;
    let skippedCount = 0;
    const seenNodeIds = new Set<number>();
    const seenEdgeIds = new Set<number>();
    const allSymbols: ReactorNode[] = [];
    const documentNodes: ReactorNode[] = [];

    for (const spec of fileSpecs) {
      const detectedLang = this.languageForFile(spec.path);
      if (detectedLang) {
        byLanguage[detectedLang] = (byLanguage[detectedLang] || 0) + 1;
      }

      const relativeForChain = normalizeRelative(
        path.relative(next.repoPath || "", spec.path)
      );
      const parentForFile = this.ensureFolderChain(
        relativeForChain,
        root,
        next.repoPath || "",
        folderByRel,
        nodes
      );

      let content: string | null = null;
      let hash: string | undefined = undefined;
      try {
        content = fs.readFileSync(spec.path, "utf-8");
        hash = fileContentHash(content);
      } catch {
        // if file read fails, let analysis handle or skip
      }

      const fileNode = this.fileNodeForProcess(parentForFile, next, spec.path, hash);
      if (!this.claimsFile(fileNode, next)) continue;

      const prev = prevById.get(fileNode.id);
      const isUnchanged =
        !options?.forceFull &&
        !!prev &&
        !!prev.contentHash &&
        !!hash &&
        prev.contentHash === hash;

      if (isUnchanged) {
        skippedCount++;
        nodes.push(fileNode);
        seenNodeIds.add(fileNode.id);
        if (next.id) {
          const childIds = await this.loadDescendantNodeIds(fileNode.id, String(next.id));
          childIds.forEach((id) => seenNodeIds.add(id));
          const edgeIds = await this.loadEdgeIdsTouching([fileNode.id, ...childIds], String(next.id));
          edgeIds.forEach((id) => seenEdgeIds.add(id));
        }
      } else {
        analysedCount++;
        nodes.push(fileNode);

        const searchable = this.buildSearchable(next, spec, content);
        if (searchable) searchables.push(searchable);

        if (fileNode.data?.language && ANALYSABLE_LANGUAGES.has(fileNode.data.language)) {
          try {
            const analysis = await this.analyseFileFull(fileNode);
            nodes.push(...analysis.symbols);
            if (analysis.symbols.length > 0) {
              allSymbols.push(...analysis.symbols);
            }
            if (fileNode.type === ReactorNodeType.DOCUMENT || fileNode.data?.kind === "document") {
              documentNodes.push(fileNode);
            }
            analysis.externals.forEach((e) => externals.set(e.id, e));
            edges.push(...analysis.edges);
            // Analysis may enrich the file's own node (a document's title,
            // frontmatter and outline). Applied in place: fileNode is already in
            // `nodes`, so the enriched version is what gets persisted.
            if (analysis.filePatch) {
              if (analysis.filePatch.description) {
                fileNode.description = analysis.filePatch.description;
              }
              if (analysis.filePatch.data) {
                fileNode.data = { ...fileNode.data, ...analysis.filePatch.data };
              }
            }
          } catch (err) {
            errorCount++;
            this.context.warn(
              `analyseFileFull failed for ${spec.path}: ${(err as Error).message}`
            );
          }
        }
      }
    }

    // Symlink nodes + resolution edges. Edges are only written for in-repo
    // targets (deterministic target id) — out-of-repo stays metadata only.
    for (const record of symlinkRecords) {
      const relForSym = normalizeRelative(
        path.relative(next.repoPath || "", record.fullPath)
      );
      const parentForSym = this.ensureFolderChain(
        relForSym,
        root,
        next.repoPath || "",
        folderByRel,
        nodes
      );
      const symlinkNode = this.symlinkNodeForProcess(parentForSym, next, record);
      nodes.push(symlinkNode);

      const resolvedNodeId = (symlinkNode.data as TreeNodeData)?.symlink?.resolvedNodeId;
      if (resolvedNodeId !== undefined) {
        edges.push({
          id: linkId(symlinkNode.id, resolvedNodeId, ReactorLinkType.SYMLINK),
          source: symlinkNode.id,
          target: resolvedNodeId,
          types: [ReactorLinkType.SYMLINK],
          title: record.classification.relativeTarget,
          description: symlinkNode.description,
          projectId: next.id as string | number,
        } as ReactorNodeLink);
      }

      const symlinkLogicalKey = pathLogicalKey(projectFqn(next), (symlinkNode.data as TreeNodeData).relativePath);
      const symlinkNodeId = nodeId(symlinkLogicalKey);

      searchables.push({
        id: symlinkLogicalKey,
        nodeId: symlinkNodeId,
        name: `symlink_${(symlinkNode.data as TreeNodeData).relativePath}`,
        nameSpace: next.nameSpace,
        version: next.version,
        source: symlinkNode.description,
        path: (symlinkNode.data as TreeNodeData).relativePath,
        relativePath: (symlinkNode.data as TreeNodeData).relativePath,
        type: { id: "symlink", name: "symlink" },
      } as Reactory.Models.ISearchable);
    }

    nodes.push(...externals.values());

    // Second pass: Document symbol mentions (Session 13)
    if (options?.linkDocMentions !== false && allSymbols.length > 0 && documentNodes.length > 0) {
      const symbolIndex = buildSymbolIndex(allSymbols);
      if (symbolIndex.size > 0) {
        for (const docNode of documentNodes) {
          try {
            const mentionGraph = analyseDocumentFile(docNode, this.context, {
              symbolIndex,
              linkDocMentions: true,
            });
            for (const mentionEdge of mentionGraph.edges) {
              if ((mentionEdge.types || []).includes(ReactorLinkType.MENTIONS)) {
                if (!edges.some((existing) => existing.id === mentionEdge.id)) {
                  if (next.id && !mentionEdge.projectId) {
                    mentionEdge.projectId = next.id as string | number;
                  }
                  edges.push(mentionEdge);
                }
              }
            }
          } catch (err) {
            this.context.warn(
              `Document mention linking failed for ${docNode.data?.relativePath}: ${(err as Error).message}`
            );
          }
        }
      }
    }

    const runId = options?.runId || randomUUID();
    const indexedAt = new Date();
    const { partnerId, organizationId } = this.resolveTenancy(next);

    const meta = {
      projectId: next.id,
      projectFqn: projectFqn(next),
      runId,
      indexedAt,
      partnerId,
      organizationId,
    };

    // Ensure any edges that arrived without projectId get stamped here too (defense in depth).
    for (const e of edges) {
      if (!e.projectId && meta.projectId) e.projectId = meta.projectId as any;
      if (!e.partnerId && partnerId) e.partnerId = partnerId;
      if (!e.organizationId && organizationId) e.organizationId = organizationId;
    }

    const persistResult = (await this.persistGraph(nodes, edges, meta)) || {
      ok: true,
      nodeOps: nodes.length,
      edgeOps: edges.length,
    };
    if (!persistResult.ok) {
      errorCount++;
    }
    await this.indexSearchables(next, searchables);

    // Cache bust: clear REACTOR_NODE_* for all written and skipped/seen node ids
    const bustIds = new Set<number>();
    nodes.forEach((n) => n && n.id !== undefined && n.id !== null && bustIds.add(n.id));
    seenNodeIds.forEach((id) => bustIds.add(id));
    await this.bustNodeCache(bustIds);

    // Re-stamp skipped unchanged nodes & edges with the new runId & indexedAt so GC preserves them
    if (seenNodeIds.size > 0) {
      await this.touchNodes(Array.from(seenNodeIds), { runId, indexedAt });
    }
    if (seenEdgeIds.size > 0) {
      await this.touchEdges(Array.from(seenEdgeIds), { runId, indexedAt });
    }

    let nodesGcDeleted = 0;
    let edgesGcDeleted = 0;
    // Project-scoped GC: remove nodes/edges for this project with a different runId.
    // Safeguards: only when projectId present; only if persistGraph succeeded; only if not skipGc; never delete 'manual' runId.
    const canGc = !options?.skipGc && !!meta.projectId && persistResult.ok;

    if (canGc) {
      const gc = await this.gcStale(String(meta.projectId), runId);
      nodesGcDeleted = gc.nodesGcDeleted;
      edgesGcDeleted = gc.edgesGcDeleted;
      if (gc.error) errorCount++;
    } else if (!options?.skipGc && meta.projectId && !persistResult.ok) {
      this.context.error(`GC skipped because persistGraph failed: ${persistResult.error}`);
    } else if (!options?.skipGc && !meta.projectId) {
      this.context.warn(`GC skipped because projectId is missing for project ${next.name || next.fqn}`);
    }

    const durationMs = Date.now() - startTime;
    const metrics: GraphProcessMetrics = {
      projectId: String(next.id || ""),
      projectFqn: projectFqn(next),
      runId,
      filesDiscovered: fileSpecs.length,
      filesAnalysed: analysedCount,
      filesSkipped: skippedCount,
      foldersCreated: folderByRel.size,
      nodesUpserted: nodes.length,
      edgesUpserted: edges.length,
      nodesGcDeleted,
      edgesGcDeleted,
      durationMs,
      errors: errorCount,
      byLanguage,
    };
    this.lastMetrics = metrics;

    try {
      this.context.info("graph.process.complete", metrics as any);
    } catch {
      this.context.info(`graph.process.complete: ${JSON.stringify(metrics)}`);
    }

    this.context.info(
      `process ${next.name}: analysed=${analysedCount} skipped=${skippedCount} folders=${folderByRel.size} edges=${edges.length} (runId=${runId}, duration=${durationMs}ms)`
    );
    return next;
  }

  async getProjectData(
    project: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    return project;
  }

  async sync(project: IReactorProject): Promise<IReactorProject> {
    const processed = await this.process(project);
    return { ...(processed as IReactorProject), lastSync: new Date() };
  }

  async index(project: IReactorProject): Promise<IReactorProject> {
    return this.process(project) as Promise<IReactorProject>;
  }

}

export default BaseProjectProcessor;
