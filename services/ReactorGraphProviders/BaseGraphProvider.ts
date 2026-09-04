import mongoose from "mongoose";
import Reactory from "@reactorynet/reactory-core";
import {
  IReactorProject,
  KnownReactorProjectTypes,
  ReactorNodeAttributes,
  GraphProcessMetrics,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorDataNode,
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import SVGS from "@reactory/server-modules/reactory-reactor/data/reactor-svgs";
import Hash from "@reactory/server-core/utils/hash";
import { PagingRequest } from "@reactory/server-core/database/types";
import {
  canonicalProjectId,
  nodeId,
  projectFqn,
  projectLogicalKey,
} from "../graph/GraphIdentity";
import { ReactorNodeModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "@reactory/server-modules/reactory-reactor/models/ReactorNodeLink";

/** Checks if MongoDB connection is active or if the model method is mocked in tests. */
export function isMongoAvailable(modelFn?: any): boolean {
  if (mongoose.connection?.readyState === 1) return true;
  if (modelFn && (modelFn.mock || modelFn._isMockFunction)) return true;
  return false;
}

/** Project/run metadata stamped onto every persisted node and edge. */
export interface GraphPersistMeta {
  projectId?: any;
  projectFqn?: string;
  runId?: string;
  indexedAt?: Date;
  partnerId?: any;
  organizationId?: any;
}

/**
 * BaseGraphProvider holds the **source-agnostic** graph plumbing shared by
 * every graph provider - filesystem project processors and external providers
 * (Jira, databases, ...) alike:
 *
 *  - deterministic project root node construction (getProjectNode),
 *  - persistence with project/run stamping (persistGraph),
 *  - search indexing to the per-project index (indexSearchables),
 *  - incremental-run support (loadPreviousNodes / loadDescendantNodeIds /
 *    loadEdgeIdsTouching / touchNodes / touchEdges),
 *  - project-scoped GC by runId (gcStale),
 *  - tenancy resolution (resolveTenancy) and node-cache busting (bustNodeCache),
 *  - icon / inspector attributes and service plumbing.
 *
 * It deliberately contains **no filesystem code**: everything fs-shaped
 * (tree walking, gitignore, file analysis) lives in BaseProjectProcessor;
 * everything remote-snapshot-shaped lives in BaseExternalGraphProvider.
 */
export abstract class BaseGraphProvider {
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
  lastMetrics?: GraphProcessMetrics;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.props = props;
    this.context = context;
  }

  // ---- Abstract contract ----------------------------------------------------

  abstract supportsProject(project: Partial<IReactorProject>): boolean;
  abstract getProjectTypes(
    project: Partial<IReactorProject>
  ): KnownReactorProjectTypes[];

  // ---- Overridable hooks ----------------------------------------------------

  /** The SVG key (in data/reactor-svgs) used for the project icon. */
  protected iconKey(): string | null {
    return null;
  }

  /** Node type used for the project root. Overridden by e.g. TSql (DATASTORE). */
  protected rootNodeType(): ReactorNodeType {
    return ReactorNodeType.SYSTEM;
  }

  /**
   * The `source` string recorded on the project root node. Filesystem projects
   * point at their repoPath; external providers override this to point at the
   * source spec (`scheme:sourceKey`).
   */
  protected rootSource(project: Partial<IReactorProject>): string | undefined {
    return project.repoPath;
  }

  // ---- Root node ------------------------------------------------------------

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
      source: this.rootSource(project),
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

  // ---- Paging ---------------------------------------------------------------

  protected applyPaging<T>(items: T[], paging?: PagingRequest): T[] {
    if (!paging || !paging.pageSize) return items;
    const page = paging.page && paging.page > 0 ? paging.page : 1;
    const start = (page - 1) * paging.pageSize;
    return items.slice(start, start + paging.pageSize);
  }

  // ---- Persistence ----------------------------------------------------------

  protected async persistGraph(
    nodes: Partial<ReactorNode>[],
    edges: ReactorNodeLink[],
    meta?: GraphPersistMeta
  ): Promise<{ ok: boolean; nodeOps: number; edgeOps: number; error?: string }> {
    // Stamp project/run metadata (single choke point) before building ops.
    // This ensures every node/edge written by process() carries projectId/runId/indexedAt.
    const stamp = (entity: any) => {
      if (meta) {
        if (meta.projectId !== undefined) entity.projectId = String(meta.projectId);
        if (meta.projectFqn) entity.projectFqn = meta.projectFqn;
        if (meta.runId) entity.runId = meta.runId;
        if (meta.indexedAt) entity.indexedAt = meta.indexedAt;
        if (meta.partnerId !== undefined) entity.partnerId = String(meta.partnerId);
        if (meta.organizationId !== undefined) entity.organizationId = String(meta.organizationId);
      }
    };

    // Build upsert operations, skipping any entry without a stable id (an
    // id-less filter would match/replace an arbitrary document). `created` and
    // `updated` are removed from the $set payload so they never collide with
    // the $setOnInsert timestamps (MongoDB rejects a field that appears in both
    // $set and $setOnInsert with "would create a conflict").
    const toOp = <T extends { id?: number | string }>(entity: T) => {
      stamp(entity);
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
      if (nodeOps.length && isMongoAvailable(ReactorNodeModel.bulkWrite)) {
        await ReactorNodeModel.bulkWrite(nodeOps, { ordered: false });
      }
      if (edgeOps.length && isMongoAvailable(ReactorNodeLinkModel.bulkWrite)) {
        await ReactorNodeLinkModel.bulkWrite(edgeOps, { ordered: false });
      }
      return { ok: true, nodeOps: nodeOps.length, edgeOps: edgeOps.length };
    } catch (err) {
      const e = err as Error;
      this.context.error(
        `persistGraph failed (nodes=${nodes.length}->${nodeOps.length} ops, edges=${edges.length}->${edgeOps.length} ops): ${e.message}\n${e.stack || ""}`
      );
      return { ok: false, nodeOps: nodeOps.length, edgeOps: edgeOps.length, error: e.message };
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

  // ---- Incremental-run support ----------------------------------------------

  /**
   * Loads previously persisted nodes for incremental comparison.
   *
   * @param types node types to load. Defaults to FILE + DOCUMENT (the
   *   filesystem pipeline's analysable artifacts). Pass `null` to load every
   *   node type - external providers track arbitrary entity types.
   */
  protected async loadPreviousNodes(
    project: Partial<IReactorProject>,
    types?: ReactorNodeType[] | null
  ): Promise<Map<number, Partial<ReactorNode>>> {
    const pid = canonicalProjectId(project);
    if (!pid || !isMongoAvailable(ReactorNodeModel.find)) return new Map();
    try {
      const query: any = { projectId: pid };
      const typeFilter =
        types === undefined
          ? [ReactorNodeType.FILE, ReactorNodeType.DOCUMENT]
          : types;
      if (typeFilter && typeFilter.length > 0) {
        query.type = { $in: typeFilter };
      }
      const previous = (await ReactorNodeModel.find(query)
        .select({ id: 1, contentHash: 1, parentId: 1, data: 1, type: 1 })
        .lean()) as unknown as Partial<ReactorNode>[];
      return new Map((previous || []).map((n) => [n.id, n]));
    } catch (err) {
      this.context.warn(`loadPreviousNodes failed: ${(err as Error).message}`);
      return new Map();
    }
  }

  /**
   * Loads descendant symbol / section node ids for an unchanged node using BFS.
   */
  protected async loadDescendantNodeIds(
    rootParentId: number,
    projectId: string
  ): Promise<number[]> {
    if (!isMongoAvailable(ReactorNodeModel.find)) return [];
    try {
      const all: number[] = [];
      let frontier = [rootParentId];
      const visited = new Set<number>([rootParentId]);
      const MAX_NODES = 50_000;
      const MAX_DEPTH = 64;

      for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && all.length < MAX_NODES; depth++) {
        const children = (await ReactorNodeModel.find({
          parentId: { $in: frontier },
          projectId: String(projectId),
        })
          .select({ id: 1 })
          .lean()) as unknown as { id: number }[];

        const next: number[] = [];
        for (const c of children) {
          if (visited.has(c.id)) continue;
          visited.add(c.id);
          all.push(c.id);
          next.push(c.id);
        }
        frontier = next;
      }
      return all;
    } catch (err) {
      this.context.warn(`loadDescendantNodeIds failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Loads edge ids touching any of the specified node ids for an unchanged node.
   */
  protected async loadEdgeIdsTouching(
    nodeIds: number[],
    projectId: string
  ): Promise<number[]> {
    if (!nodeIds.length || !isMongoAvailable(ReactorNodeLinkModel.find)) return [];
    try {
      const links = (await ReactorNodeLinkModel.find({
        projectId: String(projectId),
        $or: [{ source: { $in: nodeIds } }, { target: { $in: nodeIds } }],
      })
        .select({ id: 1 })
        .lean()) as unknown as { id: number }[];
      return links.map((l) => l.id);
    } catch (err) {
      this.context.warn(`loadEdgeIdsTouching failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Returns the subset of `ids` that exist as persisted nodes. Used by linkers
   * to stamp `data.resolved` on cross-domain edges whose deterministic target
   * may not have been synced yet (Providers Session 04).
   */
  protected async loadExistingNodeIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length || !isMongoAvailable(ReactorNodeModel.find)) return new Set();
    try {
      const rows = (await ReactorNodeModel.find({ id: { $in: ids } })
        .select({ id: 1 })
        .lean()) as unknown as { id: number }[];
      return new Set((rows || []).map((r) => r.id));
    } catch (err) {
      this.context.warn(`loadExistingNodeIds failed: ${(err as Error).message}`);
      return new Set();
    }
  }

  /**
   * Bulk-updates runId and indexedAt for skipped unchanged nodes so GC does not delete them.
   */
  protected async touchNodes(
    ids: number[],
    meta: { runId: string; indexedAt: Date }
  ): Promise<void> {
    if (!ids.length || !isMongoAvailable(ReactorNodeModel.updateMany)) return;
    try {
      await ReactorNodeModel.updateMany(
        { id: { $in: ids } },
        { $set: { runId: meta.runId, indexedAt: meta.indexedAt, updated: new Date() } }
      );
    } catch (err) {
      this.context.warn(`touchNodes failed: ${(err as Error).message}`);
    }
  }

  /**
   * Bulk-updates runId and indexedAt for skipped unchanged edges so GC does not delete them.
   */
  protected async touchEdges(
    ids: number[],
    meta: { runId: string; indexedAt: Date }
  ): Promise<void> {
    if (!ids.length || !isMongoAvailable(ReactorNodeLinkModel.updateMany)) return;
    try {
      await ReactorNodeLinkModel.updateMany(
        { id: { $in: ids } },
        { $set: { runId: meta.runId, indexedAt: meta.indexedAt, updated: new Date() } }
      );
    } catch (err) {
      this.context.warn(`touchEdges failed: ${(err as Error).message}`);
    }
  }

  // ---- GC / tenancy / cache -------------------------------------------------

  /**
   * Project-scoped GC: removes nodes/edges for the project whose runId differs
   * from the current run. `manual` edges (created outside catalog runs) are
   * always preserved. Callers gate on skipGc / persist success / discovery
   * completeness - this method only performs the deletes.
   */
  protected async gcStale(
    projectId: string,
    runId: string,
    opts?: {
      /**
       * When set, search documents of GC'd nodes are removed from this index
       * (capability-guarded, best-effort) so deleted artifacts stop surfacing
       * as stale hits (Providers Session 08). Search doc ids are logical keys:
       * reconstructed for FILE/DOCUMENT nodes from projectFqn + relativePath,
       * or read from `data.searchId` where a provider stamped it.
       */
      searchIndexName?: string;
    }
  ): Promise<{ nodesGcDeleted: number; edgesGcDeleted: number; searchablesDeleted?: number; error?: boolean }> {
    if (!projectId || !isMongoAvailable(ReactorNodeModel.deleteMany)) {
      return { nodesGcDeleted: 0, edgesGcDeleted: 0 };
    }
    try {
      const pid = String(projectId);
      const gcFilter = { projectId: pid, runId: { $nin: [runId, 'manual'] } };

      // Collect the search-document ids of the doomed nodes BEFORE deleting.
      let searchableIds: string[] = [];
      if (opts?.searchIndexName && isMongoAvailable(ReactorNodeModel.find)) {
        try {
          const doomed = (await ReactorNodeModel.find(gcFilter)
            .select({ id: 1, type: 1, projectFqn: 1, data: 1 })
            .lean()) as unknown as Partial<ReactorNode>[];
          searchableIds = (doomed || [])
            .map((n) => this.searchableIdOf(n))
            .filter((id): id is string => !!id);
        } catch (collectErr) {
          this.context.warn(
            `gcStale: searchable collection failed: ${(collectErr as Error).message}`
          );
        }
      }

      const [nodeDelRes, edgeDelRes] = await Promise.all([
        ReactorNodeModel.deleteMany(gcFilter),
        ReactorNodeLinkModel.deleteMany(gcFilter),
      ]);

      let searchablesDeleted = 0;
      if (opts?.searchIndexName && searchableIds.length > 0) {
        searchablesDeleted = await this.deleteSearchables(opts.searchIndexName, searchableIds);
      }

      return {
        nodesGcDeleted: nodeDelRes?.deletedCount || 0,
        edgesGcDeleted: edgeDelRes?.deletedCount || 0,
        searchablesDeleted,
      };
    } catch (gcErr) {
      this.context.warn(`gcStaleGraph failed: ${(gcErr as Error).message}`);
      return { nodesGcDeleted: 0, edgesGcDeleted: 0, error: true };
    }
  }

  /**
   * The search-document id (logical key) of a node, when reconstructible:
   * providers stamp `data.searchId`; FILE/DOCUMENT nodes derive it from
   * projectFqn + relativePath (the id `buildSearchable` writes).
   */
  protected searchableIdOf(node: Partial<ReactorNode>): string | null {
    const stamped = node?.data?.searchId;
    if (stamped) return String(stamped);
    const fqn = (node as any)?.projectFqn || node?.data?.projectFqn;
    const rel = node?.data?.relativePath;
    if (
      fqn &&
      rel &&
      (node.type === ReactorNodeType.FILE || node.type === ReactorNodeType.DOCUMENT)
    ) {
      return `${fqn}::${rel}`;
    }
    return null;
  }

  /** Capability-guarded, best-effort search-document deletion. */
  protected async deleteSearchables(indexName: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const search: any =
      this.searchService ||
      this.context.getService<Reactory.Service.ISearchService>(
        "core.ReactorySearchService@1.0.0"
      );
    if (!search || typeof search.deleteDocuments !== "function") {
      this.context.warn(
        `deleteSearchables: search backend does not support document deletion — ${ids.length} stale searchable(s) remain in ${indexName}`
      );
      return 0;
    }
    try {
      await search.deleteDocuments(indexName, ids);
      return ids.length;
    } catch (err) {
      this.context.warn(
        `deleteSearchables failed for ${indexName}: ${(err as Error).message}`
      );
      return 0;
    }
  }

  /** Resolves partner/organization tenancy ids from project + context metadata. */
  protected resolveTenancy(project: Partial<IReactorProject>): {
    partnerId?: string;
    organizationId?: string;
  } {
    const partnerId =
      (project as any).partnerId ||
      project.client?._id?.toString() ||
      project.client?.id?.toString() ||
      (this.context?.partner as any)?._id?.toString() ||
      (this.context?.partner as any)?.id?.toString();

    const organizationId =
      (project as any).organizationId ||
      project.organization?._id?.toString() ||
      project.organization?.id?.toString();

    return { partnerId, organizationId };
  }

  /** Best-effort clearing of REACTOR_NODE_* context cache entries. */
  protected async bustNodeCache(ids: Iterable<number>): Promise<void> {
    for (const id of ids) {
      try {
        if (typeof (this.context as any).clearValue === "function") {
          await (this.context as any).clearValue(`REACTOR_NODE_${id}`);
        } else if (typeof (this.context as any).removeValue === "function") {
          await (this.context as any).removeValue(`REACTOR_NODE_${id}`);
        } else if (typeof this.context.setValue === "function") {
          await this.context.setValue(`REACTOR_NODE_${id}`, null);
        }
      } catch {
        // cache clear best-effort
      }
    }
  }

  // ---- Attributes -----------------------------------------------------------

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
    attributes.push(...this.documentAttributes(node));
    return attributes;
  }

  /**
   * Inspectable attributes for document and section nodes, so the explorer can
   * show what a document is about without opening it.
   */
  private documentAttributes(node: ReactorNode): ReactorNodeAttributes[] {
    const data = node?.data;
    if (!data || typeof data !== "object") return [];

    const attributes: ReactorNodeAttributes[] = [];
    const push = (attributeKey: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      if (Array.isArray(value) && value.length === 0) return;
      attributes.push({
        id: Hash(`${node.id}_${attributeKey}`),
        key: attributeKey,
        value: Array.isArray(value) ? value.join(", ") : value,
      });
    };

    if (data.kind === "document") {
      push("title", data.documentTitle);
      push("format", data.documentFormat);
      push("tags", data.tags);
      push("sections", data.documentMetrics?.sections);
      push("reading-minutes", data.documentMetrics?.readingMinutes);
      push("code-languages", data.codeLanguages);
      // Frontmatter ownership fields are the ones people actually look for.
      ["owner", "team", "status", "reviewed", "updated"].forEach((field) =>
        push(field, data.frontmatter?.[field])
      );
    }

    if (data.kind === "section") {
      push("anchor", data.slug ? `#${data.slug}` : undefined);
      push("heading-level", data.level);
      push("lines", data.lines);
      push("starts-at-line", data.line);
    }

    if (data.kind === "topic") push("topic", data.label);
    if (data.kind === "resource") {
      push("url", data.url);
      push("host", data.host);
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

export default BaseGraphProvider;
