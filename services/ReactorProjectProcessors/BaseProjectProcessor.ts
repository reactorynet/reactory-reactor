import fs from "fs";
import path from "path";
import ignore from "ignore";
import Reactory from "@reactorynet/reactory-core";
import {
  IReactorProject,
  IReactorProjectFileSpec,
  IProjectProcessor,
  ReactorNodeAttributes,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorDataNode,
  ReactorLinkType,
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import SVGS from "@reactory/server-modules/reactory-reactor/data/reactor-svgs";
import { PagingRequest } from "@reactory/server-core/database/types";
import Hash from "@reactory/server-core/utils/hash";
import {
  appendAncestry,
  linkId,
  nodeId,
  normalizeRelative,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
} from "../graph/GraphIdentity";
import { ReactorNodeModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "@reactory/server-modules/reactory-reactor/models/ReactorNodeLink";

/**
 * The result of a deep analysis of a single source file: the symbol nodes it
 * contains, external dependency nodes it references, and the edges (imports,
 * references) it originates.
 */
export interface FileAnalysisResult {
  symbols: ReactorNode[];
  externals: ReactorNode[];
  edges: ReactorNodeLink[];
}

/** Maximum characters of file content stored on a searchable. */
const MAX_SEARCHABLE_CONTENT = 100_000;

/** Languages a processor may deep-analyse during process(). */
const ANALYSABLE_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "java",
  "csharp",
  "kotlin",
  "markdown",
  "yaml",
  "terraform",
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
  kind: "folder" | "file" | "symbol" | "submodule" | "symlink";
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
export abstract class BaseProjectProcessor implements IProjectProcessor {
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;

  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;
  searchService: Reactory.Service.ISearchService;

  abstract nameSpace: string;
  abstract name: string;
  abstract version: string;
  description?: string;
  tags?: string[];

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

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.props = props;
    this.context = context;
  }

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

  abstract supportsProject(project: Partial<IReactorProject>): boolean;
  abstract getProjectTypes(
    project: Partial<IReactorProject>
  ): KnownReactorProjectTypes[];

  /** The SVG key (in data/reactor-svgs) used for the project icon. */
  protected iconKey(): string | null {
    return null;
  }

  /** Node type used for the project root. Overridden by e.g. TSql (DATASTORE). */
  protected rootNodeType(): ReactorNodeType {
    return ReactorNodeType.SYSTEM;
  }

  /**
   * Deep-analyse a FILE node into symbol nodes, external dependency nodes and
   * edges. Default: files are opaque leaves. Language processors override this
   * (e.g. NodeJS wires in the TypeScript AST analyzer). Both interactive tree
   * expansion (analyseFile) and batch processing (process) build on this.
   */
  protected async analyseFileFull(
    _fileNode: ReactorNode
  ): Promise<FileAnalysisResult> {
    return { symbols: [], externals: [], edges: [] };
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

  /** Coarse language classification from a file extension. */
  protected languageForFile(fileName: string): string | undefined {
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
      ".md": "markdown",
      ".markdown": "markdown",
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

  async getProjectNode(
    project: Partial<IReactorProject>
  ): Promise<Partial<ReactorDataNode<Partial<IReactorProject>>>> {
    const fqn = projectFqn(project);
    const id = nodeId(projectLogicalKey(project));
    const cacheKey = `REACTOR_NODE_${id}`;
    const cached = await this.context.getValue<
      Partial<ReactorDataNode<Partial<IReactorProject>>>
    >(cacheKey);
    if (cached) return cached;

    const node: Partial<ReactorDataNode<Partial<IReactorProject>>> = {
      id,
      index: id,
      key: `${id}`,
      name: project.name,
      version: project.version,
      nameSpace: project.nameSpace,
      providerId: this.fqn(),
      source: project.repoPath,
      parentId: null,
      type: this.rootNodeType(),
      categories: [],
      description: project.description,
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      // Root data is the project itself, augmented with the fields descendants
      // rely on so the walker never needs a DB round-trip.
      data: { ...project, repoPath: project.repoPath, projectFqn: fqn, projectId: project.id },
    };

    await this.context.setValue(cacheKey, node);
    return node;
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
        : "file",
      language: isDirectory || isSymlink ? undefined : this.languageForFile(entryName),
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
      : `${isSubmodule ? "Submodule" : isDirectory ? "Folder" : "File"} ${relativePath}`;

    return {
      id,
      index: id,
      name: entryName,
      key: appendAncestry(parent.key, id),
      type: isDirectory ? ReactorNodeType.FOLDER : ReactorNodeType.FILE,
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

    // FILE nodes expand into symbols (if a language analyzer is provided).
    if (node.type === ReactorNodeType.FILE) {
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

  private applyPaging<T>(items: T[], paging?: PagingRequest): T[] {
    if (!paging || !paging.pageSize) return items;
    const page = paging.page && paging.page > 0 ? paging.page : 1;
    const start = (page - 1) * paging.pageSize;
    return items.slice(start, start + paging.pageSize);
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

  /** Builds a FILE node parented to the project root (used by batch process). */
  private fileNodeForProcess(
    root: Partial<ReactorNode>,
    project: Partial<IReactorProject>,
    absPath: string
  ): ReactorNode {
    const fqn = projectFqn(project);
    const relativePath = normalizeRelative(
      path.relative(project.repoPath || "", absPath)
    );
    const id = nodeId(pathLogicalKey(fqn, relativePath));
    return {
      id,
      index: id,
      name: path.basename(absPath),
      key: appendAncestry(root.key, id),
      type: ReactorNodeType.FILE,
      description: `File ${relativePath}`,
      parentId: root.id,
      providerId: this.fqn(),
      nameSpace: project.nameSpace,
      version: project.version,
      source: absPath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: {
        path: absPath,
        relativePath,
        repoPath: project.repoPath,
        projectFqn: fqn,
        projectId: project.id,
        kind: "file",
        language: this.languageForFile(absPath),
      },
    };
  }

  /** Builds a symlink node parented to the project root (used by batch process). */
  private symlinkNodeForProcess(
    root: Partial<ReactorNode>,
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
      key: appendAncestry(root.key, id),
      // The link node keeps its target's natural type; broken links are FILE.
      type: classification.isDir ? ReactorNodeType.FOLDER : ReactorNodeType.FILE,
      description: `Symlink ${relativePath}${classification.relativeTarget ? ` -> ${classification.relativeTarget}` : classification.broken ? " (broken)" : ""}`,
      parentId: root.id,
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
    fileSpec: Partial<IReactorProjectFileSpec>
  ): Reactory.Models.ISearchable | null {
    try {
      const content = fs.readFileSync(fileSpec.path, "utf-8");
      const lines = content.split("\n");
      const fileName = fileSpec.path.split(path.sep).pop();
      // Key the searchable on the project-relative path, not the bare file name:
      // large repos have many files that share a basename (e.g. index.ts), and a
      // basename-only id collapses them to one id, so most get overwritten in the
      // search index (thousands of files silently lost).
      const relativePath = normalizeRelative(
        path.relative(project.repoPath || "", fileSpec.path)
      );
      const idString = `${projectFqn(project)}_${fileSpec.type}_${relativePath}`;
      return {
        id: Hash(idString),
        name: `${fileSpec.type}_${relativePath}`,
        nameSpace: project.nameSpace,
        version: project.version,
        source: content.slice(0, MAX_SEARCHABLE_CONTENT),
        path: fileSpec.path,
        metrics: [{ unit: "lines", value: lines.length, name: "Line Count" }],
        type: { id: fileSpec.type, name: fileSpec.type },
      } as Reactory.Models.ISearchable;
    } catch {
      return null;
    }
  }

  /** Upserts nodes and edges by their deterministic ids (idempotent). */
  protected async persistGraph(
    nodes: Partial<ReactorNode>[],
    edges: ReactorNodeLink[]
  ): Promise<void> {
    // Build upsert operations, skipping any entry without a stable id (an
    // id-less filter would match/replace an arbitrary document). `created` and
    // `updated` are removed from the $set payload so they never collide with
    // the $setOnInsert timestamps (MongoDB rejects a field that appears in both
    // $set and $setOnInsert with "would create a conflict").
    const toOp = <T extends { id?: number | string }>(entity: T) => {
      const { created, updated, ...rest } = entity as T & {
        created?: Date;
        updated?: Date;
      };
      const now = new Date();
      return {
        updateOne: {
          filter: { id: entity.id },
          update: { $set: { ...rest, updated: now }, $setOnInsert: { created: now } },
          upsert: true,
        },
      };
    };

    const nodeOps = nodes.filter((n) => n && n.id !== undefined && n.id !== null).map(toOp);
    const edgeOps = edges.filter((e) => e && e.id !== undefined && e.id !== null).map(toOp);

    try {
      if (nodeOps.length) {
        await ReactorNodeModel.bulkWrite(nodeOps, { ordered: false });
      }
      if (edgeOps.length) {
        await ReactorNodeLinkModel.bulkWrite(edgeOps, { ordered: false });
      }
    } catch (err) {
      const e = err as Error;
      this.context.error(
        `persistGraph failed (nodes=${nodes.length}->${nodeOps.length} ops, edges=${edges.length}->${edgeOps.length} ops): ${e.message}\n${e.stack || ""}`
      );
    }
  }

  /** Writes searchables to the per-project search index. */
  protected async indexSearchables(
    project: Partial<IReactorProject>,
    searchables: Reactory.Models.ISearchable[]
  ): Promise<void> {
    if (!searchables.length) return;
    const search =
      this.searchService ||
      this.context.getService<Reactory.Service.ISearchService>(
        "core.ReactorySearchService@1.0.0"
      );
    if (!search) {
      this.context.warn("No search service available; skipping index");
      return;
    }
    const indexName = `reactor_graph_${project.nameSpace}_${project.name}`;
    try {
      await search.index(indexName, searchables);
    } catch (err) {
      this.context.error(`Failed to index ${indexName}: ${(err as Error).message}`);
    }
  }

  /**
   * Full pipeline for a project: discover files, build the project root + file
   * + symbol + external nodes, resolve edges, persist the graph, and index file
   * contents for search. Raw folder browsing remains lazy; only analysed
   * artifacts are persisted.
   */
  async process(
    project: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    const next = { ...project };
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

    for (const spec of fileSpecs) {
      const fileNode = this.fileNodeForProcess(root, next, spec.path);
      nodes.push(fileNode);

      const searchable = this.buildSearchable(next, spec);
      if (searchable) searchables.push(searchable);

      if (fileNode.data?.language && ANALYSABLE_LANGUAGES.has(fileNode.data.language)) {
        try {
          const analysis = await this.analyseFileFull(fileNode);
          nodes.push(...analysis.symbols);
          analysis.externals.forEach((e) => externals.set(e.id, e));
          edges.push(...analysis.edges);
        } catch (err) {
          this.context.warn(
            `analyseFileFull failed for ${spec.path}: ${(err as Error).message}`
          );
        }
      }
    }

    // Symlink nodes + resolution edges. Edges are only written for in-repo
    // targets (deterministic target id) — out-of-repo stays metadata only.
    for (const record of symlinkRecords) {
      const symlinkNode = this.symlinkNodeForProcess(root, next, record);
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

      searchables.push({
        id: Hash(`${projectFqn(next)}_symlink_${(symlinkNode.data as TreeNodeData).relativePath}`),
        name: `symlink_${(symlinkNode.data as TreeNodeData).relativePath}`,
        nameSpace: next.nameSpace,
        version: next.version,
        source: symlinkNode.description,
        path: record.fullPath,
        type: { id: "symlink", name: "symlink" },
      } as Reactory.Models.ISearchable);
    }

    nodes.push(...externals.values());
    await this.persistGraph(nodes, edges);
    await this.indexSearchables(next, searchables);

    this.context.info(
      `Processed ${next.name}: ${nodes.length} nodes, ${edges.length} edges, ${searchables.length} searchables`
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

  // ---- Attributes ----------------------------------------------------------

  async getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    const attributes: ReactorNodeAttributes[] = [];
    const key = this.iconKey();
    if (key && (SVGS as Record<string, string>)[key]) {
      attributes.push({
        id: Hash(`${node.id}_icon-svg`),
        key: "icon",
        value: { type: "svg", svg: (SVGS as Record<string, string>)[key] },
      });
    }
    return attributes;
  }

  // ---- Service plumbing ----------------------------------------------------

  fqn(): string {
    return `${this.nameSpace}.${this.name}@${this.version}`;
  }

  onStartup(): Promise<void> {
    return Promise.resolve();
  }

  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}${includeVersion ? `@${this.version}` : ""}`;
  }

  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }

  setExecutionContext(executionContext: Reactory.Server.IReactoryContext): void {
    this.context = executionContext;
  }

  setFileService(fileService: Reactory.Service.IReactoryFileService): void {
    this.fileService = fileService;
  }

  setFetchService(fetchService: Reactory.Service.IFetchService): void {
    this.fetchService = fetchService;
  }

  setReactorySearchService(searchService: Reactory.Service.ISearchService): void {
    this.searchService = searchService;
  }
}

export default BaseProjectProcessor;
