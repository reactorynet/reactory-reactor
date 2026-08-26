import Reactory from "@reactorynet/reactory-core";
import ApiError from "@reactory/server-core/exceptions";
import { randomUUID } from "crypto";

import { IReactorProject, IProjectProcessor, ISystemGraphManager, PagedFilter, PageReactorProjectResult, ReactorProjectService } from "../types/service.types"
import Hash from "@reactory/server-core/utils/hash";
import { ReactorDataNode, ReactorNode, ReactorNodeCategory, ReactorNodeLink, ReactorLinkType, ReactorNodeType, ReactorSubgraph, ReactorSubgraphOptions } from "../types/model.types";
import { DefaultReactorNodeCategories, ReactorNodeModel } from '../models/ReactorGraphNode';
import { ReactorNodeLinkModel } from '../models/ReactorNodeLink';
import { linkId, nodeId, projectLogicalKey } from './graph/GraphIdentity';
import { service } from "@reactory/server-core/application/decorators";

@service({
  name: "SystemGraphManager",
    nameSpace: "reactor",
    version: "1.0.0",
    description: "Service for catalogging and creating a graph for a given system",
    id: "reactor.SystemGraphManager@1.0.0",
    serviceType: "data",       
    dependencies: [
      { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },      
      { id: "core.FetchService@1.0.0", alias: "fetchService" },
      { id: "core.ReactorySearchService@1.0.0", alias: "searchService"},
      { id: "reactor.ReactorProjectService@1.0.0", alias: "projectService" }
    ],
})
class SystemGraphManager implements ISystemGraphManager {
  
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;

  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;
  searchService: Reactory.Service.ISearchService;
  projectService: ReactorProjectService;
  
  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.props = props;
    this.getCatalogNodes = this.getCatalogNodes.bind(this);   
    this.getProjectNode = this.getProjectNode.bind(this);
    this.getCatalogNode = this.getCatalogNode.bind(this);
    this.getNode = this.getNode.bind(this);
    this.getCategoryNodes = this.getCategoryNodes.bind(this);
    this.getProjects = this.getProjects.bind(this);
    this.getProject = this.getProject.bind(this);
    this.catalogProject = this.catalogProject.bind(this);
    this.catalogProjects = this.catalogProjects.bind(this);
    this.getLinks = this.getLinks.bind(this);
    this.getNodes = this.getNodes.bind(this);
    this.getNodeLinks = this.getNodeLinks.bind(this);
    this.getSubgraph = this.getSubgraph.bind(this);
    this.searchNodes = this.searchNodes.bind(this);
    this.findPath = this.findPath.bind(this);
    this.createLink = this.createLink.bind(this);
    this.updateLink = this.updateLink.bind(this);
    this.deleteLink = this.deleteLink.bind(this);
    this.findNodesByType = this.findNodesByType.bind(this);
    this.findNodesByCategory = this.findNodesByCategory.bind(this);
    this.findLinks = this.findLinks.bind(this);
    this.updateNode = this.updateNode.bind(this);
    this.getChildren = this.getChildren.bind(this);
    this.getProjectForCatalogNode = this.getProjectForCatalogNode.bind(this);
    this.setSearchService = this.setSearchService.bind(this);
    this.setFetchService = this.setFetchService.bind(this);
    this.setFileService = this.setFileService.bind(this);
    this.getExecutionContext = this.getExecutionContext.bind(this);
    this.setExecutionContext = this.setExecutionContext.bind(this);

  }
  setProjectService(service: ReactorProjectService) {
    this.projectService = service;
  }

  setSearchService(service: Reactory.Service.ISearchService) {
    this.searchService = service;
  }

  setFetchService(service: Reactory.Service.IFetchService) {
    this.fetchService = service;
  }

  setFileService(service: Reactory.Service.IReactoryFileService) {
    this.fileService = service;
  }

  async getChildren(parents: ReactorNode[]): Promise<ReactorNode[]> {    
    const { context } = this;

    if(parents.length === 0) {
      return Promise.resolve([]);
    }

    const children: ReactorNode[] = [];

    const promises = parents.map(async (parent) => {
      if (!parent?.providerId) {
        context.warn(`Node ${parent?.id} has no providerId; cannot resolve children`);
        return [] as ReactorNode[];
      }
      const provider = context.getService<IProjectProcessor>(parent.providerId);
      if (!provider || typeof provider.getChildrenForNode !== 'function') {
        context.warn(`Provider ${parent.providerId} not found for node ${parent.id}`);
        return [] as ReactorNode[];
      }
      try {
        return (await provider.getChildrenForNode(parent, parent.key, null, null)) || [];
      } catch (err) {
        context.error(`getChildrenForNode failed for node ${parent.id}: ${(err as Error).message}`);
        return [] as ReactorNode[];
      }
    });

    const results = await Promise.all(promises);
    results.forEach((result) => {
      if (Array.isArray(result)) children.push(...result);
    });

    return children;
  }
  /**
   * Returns edges touching any of the given source or target nodes, optionally
   * filtered by link type. Edges reference nodes by their deterministic id, so
   * this works even when the endpoint nodes are not currently materialised in
   * the lazy tree cache.
   */
  async getLinks(sources: ReactorNode[], types: string[], targets: ReactorNode[]): Promise<ReactorNodeLink[]> {
    const query: any = {};
    const or: any[] = [];
    const sourceIds = (sources || []).map((s) => s.id).filter((id) => id !== undefined);
    const targetIds = (targets || []).map((t) => t.id).filter((id) => id !== undefined);
    if (sourceIds.length) or.push({ source: { $in: sourceIds } });
    if (targetIds.length) or.push({ target: { $in: targetIds } });
    if (or.length) query.$or = or;
    if (types && types.length) query.types = { $in: types };
    return ReactorNodeLinkModel.find(query).lean() as unknown as ReactorNodeLink[];
  }

  /**
   * Batch node resolution by deterministic id. Resolution order per id:
   * persisted graph (one $in query for the whole batch), lazy tree cache,
   * then a minimal placeholder so non-null edge endpoints never crash.
   */
  async getNodes(ids: number[]): Promise<Partial<ReactorNode>[]> {
    const { context } = this;
    const unique = Array.from(new Set((ids || []).filter((id) => id !== undefined && id !== null)));
    if (unique.length === 0) return [];

    const persisted = (await ReactorNodeModel.find({ id: { $in: unique } }).lean()) as unknown as ReactorNode[];
    const byId = new Map<number, Partial<ReactorNode>>(persisted.map((n) => [n.id, n]));

    const misses = unique.filter((id) => !byId.has(id));
    await Promise.all(
      misses.map(async (id) => {
        const cached = await context.getValue<ReactorNode>(`REACTOR_NODE_${id}`);
        if (cached) byId.set(id, cached);
      })
    );

    return unique.map(
      (id) =>
        byId.get(id) || {
          id,
          index: id,
          key: `${id}`,
          name: `#${id}`,
          type: ReactorNodeType.PROCESS,
          nameSpace: 'reactor',
          version: '1.0.0',
          description: 'Unresolved node',
          children: [],
        }
    );
  }

  /**
   * Direction-aware, bounded edge lookup for a set of nodes. Preferred over
   * getLinks for new callers — always applies a result limit.
   */
  async getNodeLinks(
    nodeIds: number[],
    opts: {
      direction?: 'in' | 'out' | 'both';
      types?: string[];
      limit?: number;
      projectId?: string;
    } = {}
  ): Promise<ReactorNodeLink[]> {
    const ids = Array.from(new Set((nodeIds || []).filter((id) => id !== undefined && id !== null)));
    if (ids.length === 0) return [];

    const { direction = 'both', types, projectId } = opts;
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

    const or: any[] = [];
    if (direction === 'out' || direction === 'both') or.push({ source: { $in: ids } });
    if (direction === 'in' || direction === 'both') or.push({ target: { $in: ids } });

    const query: any = { $or: or };
    if (types && types.length) query.types = { $in: types };
    if (projectId) query.projectId = projectId;

    return ReactorNodeLinkModel.find(query).limit(limit).lean() as unknown as ReactorNodeLink[];
  }

  /**
   * Bounded BFS over the persisted graph starting at rootId. Returns the
   * neighbourhood as flat node + link arrays. CONTAINS edges are synthesized
   * from parentId relationships (never persisted). When `materialize` is set,
   * frontier FOLDER/SYSTEM nodes without persisted children are lazily
   * expanded via their provider, up to `materializeBudget` expansions.
   */
  async getSubgraph(rootId: number, opts: ReactorSubgraphOptions = {}): Promise<ReactorSubgraph> {
    const depth = Math.min(Math.max(opts.depth ?? 2, 1), 5);
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const direction = opts.direction ?? 'both';
    const includeContainment = opts.includeContainment !== false;
    const materialize = opts.materialize === true;
    const materializeBudget = Math.min(Math.max(opts.materializeBudget ?? 200, 0), 1000);

    const nodeTypeFilter = opts.nodeTypes && opts.nodeTypes.length ? new Set(opts.nodeTypes.map(String)) : null;

    const nodesById = new Map<number, Partial<ReactorNode>>();
    const linksById = new Map<number, Partial<ReactorNodeLink>>();
    const childCountByParent = new Map<number, number>();
    let truncated = false;
    let depthReached = 0;
    let materializations = 0;

    const [root] = await this.getNodes([rootId]);
    nodesById.set(rootId, root);
    if (root?.parentId != null) {
      childCountByParent.set(root.parentId, (childCountByParent.get(root.parentId) || 0) + 1);
    }

    let frontier: number[] = [rootId];

    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const remaining = limit - nodesById.size;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const nextFrontier = new Set<number>();

      // Persisted edges touching the frontier.
      const edges = await this.getNodeLinks(frontier, {
        direction,
        types: opts.linkTypes as string[] | undefined,
        // Fetch generously; node limit is what actually bounds the result.
        limit: Math.min(remaining * 4, 2000),
      });

      for (const edge of edges) {
        if (linksById.has(edge.id)) continue;
        linksById.set(edge.id, edge);
        for (const endpoint of [edge.source, edge.target]) {
          if (!nodesById.has(endpoint)) nextFrontier.add(endpoint);
        }
      }

      // Containment: children of the frontier via parentId.
      if (includeContainment) {
        const children = (await ReactorNodeModel.find({ parentId: { $in: frontier } })
          .limit(Math.max(remaining, 1))
          .lean()) as unknown as ReactorNode[];
        for (const child of children) {
          if (nodeTypeFilter && !nodeTypeFilter.has(String(child.type))) continue;
          if (child.parentId != null) {
            childCountByParent.set(child.parentId, (childCountByParent.get(child.parentId) || 0) + 1);
          }
          const containsId = linkId(child.parentId, child.id, ReactorLinkType.CONTAINS);
          if (!linksById.has(containsId)) {
            linksById.set(containsId, {
              id: containsId,
              source: child.parentId,
              target: child.id,
              types: [ReactorLinkType.CONTAINS],
              title: 'contains',
            });
          }
          if (!nodesById.has(child.id) && nodesById.size < limit) {
            nodesById.set(child.id, child);
            nextFrontier.add(child.id);
          } else if (!nodesById.has(child.id)) {
            truncated = true;
          }
        }
      }

      // Lazy materialization for frontier nodes with no persisted children.
      if (materialize && materializations < materializeBudget) {
        const frontierNodes = frontier
          .map((id) => nodesById.get(id))
          .filter((n): n is Partial<ReactorNode> => !!n && !!n.providerId && (n as any)?.data?.noExpand !== true);
        for (const parent of frontierNodes) {
          if (materializations >= materializeBudget || nodesById.size >= limit) {
            truncated = truncated || materializations >= materializeBudget;
            break;
          }
          const hasPersistedChild = (childCountByParent.get(parent.id) || 0) > 0;
          if (hasPersistedChild) continue;
          materializations++;
          const children = await this.getChildren([parent as ReactorNode]);
          for (const child of children) {
            if (nodesById.size >= limit) {
              truncated = true;
              break;
            }
            if (nodeTypeFilter && !nodeTypeFilter.has(String(child.type))) continue;
            if (!nodesById.has(child.id)) {
              nodesById.set(child.id, child);
              if (child.parentId != null) {
                childCountByParent.set(child.parentId, (childCountByParent.get(child.parentId) || 0) + 1);
              }
              nextFrontier.add(child.id);
            }
            const containsId = linkId(parent.id, child.id, ReactorLinkType.CONTAINS);
            if (includeContainment && !linksById.has(containsId)) {
              linksById.set(containsId, {
                id: containsId,
                source: parent.id,
                target: child.id,
                types: [ReactorLinkType.CONTAINS],
                title: 'contains',
              });
            }
          }
        }
      }

      // Resolve edge endpoints discovered this level.
      const toResolve = Array.from(nextFrontier).filter((id) => !nodesById.has(id));
      if (toResolve.length > 0) {
        const budget = limit - nodesById.size;
        if (toResolve.length > budget) {
          truncated = true;
          toResolve.length = Math.max(budget, 0);
        }
        const resolved = await this.getNodes(toResolve);
        for (const node of resolved) {
          if (nodeTypeFilter && !nodeTypeFilter.has(String(node.type))) {
            nextFrontier.delete(node.id);
            continue;
          }
          nodesById.set(node.id, node);
          if (node.parentId != null) {
            childCountByParent.set(node.parentId, (childCountByParent.get(node.parentId) || 0) + 1);
          }
        }
      }

      frontier = Array.from(nextFrontier).filter((id) => nodesById.has(id));
      if (frontier.length > 0) depthReached = level + 1;
    }

    // Drop links whose endpoints were filtered/truncated out of the node set.
    const links = Array.from(linksById.values()).filter(
      (l) => nodesById.has(l.source) && nodesById.has(l.target)
    );

    return {
      rootId,
      nodes: Array.from(nodesById.values()),
      links,
      truncated,
      stats: {
        nodeCount: nodesById.size,
        linkCount: links.length,
        depthReached,
      },
    };
  }

  /**
   * Search for nodes by term. When a project scope (nameSpace + name) is given
   * the project's search index is used; otherwise an escaped-regex match over
   * the persisted graph's name/description.
   */
  async searchNodes(
    term: string,
    opts: { nameSpace?: string; name?: string; limit?: number } = {}
  ): Promise<Partial<ReactorNode>[]> {
    const { context } = this;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    if (!term || term.trim().length === 0) return [];

    if (opts.nameSpace && opts.name) {
      const searchResults = await this.searchService.search<Partial<Reactory.Models.ISearchable>>(
        `reactor_graph_${opts.nameSpace}_${opts.name}`,
        term,
        ['name', 'nameSpace', 'description'],
        limit,
        0
      );
      const ids = searchResults.results.map((r) => {
        if (typeof (r as any).nodeId === 'number') return (r as any).nodeId;
        if (typeof r.id === 'number') return r.id;
        return nodeId(String(r.id));
      });
      const persisted = await this.getNodes(ids);
      const persistedById = new Map(persisted.map((n) => [n.id, n]));
      return searchResults.results.map((r, i) => {
        const id = ids[i];
        const node = persistedById.get(id);
        if (node && node.description !== 'Unresolved node') return node;
        return {
          id,
          index: id,
          key: `${id}`,
          name: r.name,
          nameSpace: r.nameSpace,
          version: r.version,
          type: ReactorNodeType.FILE,
          description: r.source,
        } as Partial<ReactorNode>;
      });
    }

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
    const rx = new RegExp(escaped, "i");
    const persisted = (await ReactorNodeModel.find({
      $or: [{ name: rx }, { description: rx }],
    })
      .limit(limit)
      .lean()) as unknown as Partial<ReactorNode>[];
    if (persisted && persisted.length) return persisted;

    const allNodes = await this.getCatalogNodes();
    const lower = term.toLowerCase();
    return allNodes.filter(
      (node) =>
        (node.name && node.name.toLowerCase().includes(lower)) ||
        (node.description && node.description.toLowerCase().includes(lower))
    ).slice(0, limit);
  }

  /**
   * Bounded shortest-path search between two nodes over the persisted edges.
   * BFS with parent tracking; `direction: 'both'` treats edges as undirected.
   */
  async findPath(
    sourceId: number,
    targetId: number,
    opts: { maxDepth?: number; linkTypes?: string[]; direction?: 'out' | 'both' } = {}
  ): Promise<{ found: boolean; nodeIds: number[]; links: ReactorNodeLink[] }> {
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? 6, 1), 10);
    const direction = opts.direction ?? 'both';
    const MAX_VISITED = 5000;

    if (sourceId === targetId) return { found: true, nodeIds: [sourceId], links: [] };

    const visited = new Set<number>([sourceId]);
    // nodeId -> the edge that discovered it (for path reconstruction)
    const discoveredBy = new Map<number, ReactorNodeLink>();
    let frontier: number[] = [sourceId];

    for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
      if (visited.size > MAX_VISITED) break;

      const edges = await this.getNodeLinks(frontier, {
        direction: direction === 'both' ? 'both' : 'out',
        types: opts.linkTypes,
        limit: 2000,
      });

      const nextFrontier: number[] = [];
      for (const edge of edges) {
        const candidates =
          direction === 'both' ? [edge.source, edge.target] : [edge.target];
        for (const next of candidates) {
          if (visited.has(next)) continue;
          visited.add(next);
          discoveredBy.set(next, edge);
          if (next === targetId) {
            // Reconstruct path.
            const nodeIds: number[] = [targetId];
            const links: ReactorNodeLink[] = [];
            let current = targetId;
            while (current !== sourceId) {
              const via = discoveredBy.get(current);
              if (!via) break;
              links.unshift(via);
              current = via.source === current ? via.target : via.source;
              nodeIds.unshift(current);
            }
            return { found: true, nodeIds, links };
          }
          nextFrontier.push(next);
        }
      }
      frontier = nextFrontier;
    }

    return { found: false, nodeIds: [], links: [] };
  }

  /**
   * Creates (or upserts) an edge between two nodes. The edge id is derived from
   * (source, target, type) so re-creating the same relationship is idempotent.
   */
  async createLink(source: ReactorNode, type: string, target: ReactorNode): Promise<ReactorNodeLink> {
    const id = linkId(source.id, target.id, type);
    const now = new Date();
    await ReactorNodeLinkModel.updateOne(
      { id },
      {
        $set: {
          source: source.id,
          target: target.id,
          type,
          types: [type as ReactorLinkType],
          updated: now,
        },
        $setOnInsert: { id, created: now, runId: 'manual' },
      },
      { upsert: true }
    );
    return ReactorNodeLinkModel.findOne({ id }).lean() as unknown as ReactorNodeLink;
  }

  async updateLink(link: ReactorNodeLink): Promise<ReactorNodeLink> {
    await ReactorNodeLinkModel.updateOne(
      { id: link.id },
      { $set: { ...link, updated: new Date() } }
    );
    return ReactorNodeLinkModel.findOne({ id: link.id }).lean() as unknown as ReactorNodeLink;
  }

  async deleteLink(link: ReactorNodeLink): Promise<ReactorNodeLink> {
    const existing = (await ReactorNodeLinkModel.findOne({ id: link.id }).lean()) as unknown as ReactorNodeLink;
    await ReactorNodeLinkModel.deleteOne({ id: link.id });
    return existing;
  }

  async findNodesByType(types: string[], limit: number = 100): Promise<Partial<ReactorNode>[]> {
    if (!types || types.length === 0) return [];
    const cappedLimit = Math.min(Math.max(limit, 1), 500);
    const persisted = (await ReactorNodeModel.find({
      type: { $in: types },
    })
      .limit(cappedLimit)
      .lean()) as unknown as Partial<ReactorNode>[];
    if (persisted && persisted.length) return persisted;

    const allNodes = await this.getCatalogNodes();
    return allNodes.filter((node) => types.includes(node.type)).slice(0, cappedLimit);
  }

  async findNodesByCategory(categoryIds: number[], limit: number = 100): Promise<Partial<ReactorNode>[]> {
    if (!categoryIds || categoryIds.length === 0) return [];
    const cappedLimit = Math.min(Math.max(limit, 1), 500);
    const persisted = (await ReactorNodeModel.find({
      'categories.id': { $in: categoryIds },
    })
      .limit(cappedLimit)
      .lean()) as unknown as Partial<ReactorNode>[];
    if (persisted && persisted.length) return persisted;

    const allNodes = await this.getCatalogNodes();
    return allNodes
      .filter((node) => node.categories && node.categories.some((cat) => categoryIds.includes(cat.id)))
      .slice(0, cappedLimit);
  }

  async findLinks(options: {
    sources?: number[];
    targets?: number[];
    types?: string[];
    projectId?: string;
    paging?: PagingRequest;
  } = {}): Promise<{ links: ReactorNodeLink[]; paging: PagingResult }> {
    const page = Math.max(options.paging?.page || 1, 1);
    const pageSize = Math.min(Math.max(options.paging?.pageSize || 100, 1), 500);
    const skip = (page - 1) * pageSize;

    const or: any[] = [];
    if (options.sources && options.sources.length) or.push({ source: { $in: options.sources } });
    if (options.targets && options.targets.length) or.push({ target: { $in: options.targets } });

    const query: any = {};
    if (or.length) query.$or = or;
    if (options.types && options.types.length) query.types = { $in: options.types };
    if (options.projectId) query.projectId = options.projectId;

    const [links, total] = await Promise.all([
      ReactorNodeLinkModel.find(query)
        .skip(skip)
        .limit(pageSize)
        .lean() as unknown as Promise<ReactorNodeLink[]>,
      ReactorNodeLinkModel.countDocuments(query),
    ]);

    return {
      links,
      paging: {
        total,
        page,
        pageSize,
        hasNext: skip + links.length < total,
      },
    };
  }

  async updateNode(id: number, patch: Partial<ReactorNode>): Promise<Partial<ReactorNode>> {
    const updatePayload: any = {
      ...patch,
      updated: new Date(),
    };
    delete updatePayload.id;

    const updated = (await ReactorNodeModel.findOneAndUpdate(
      { id },
      { $set: updatePayload },
      { new: true }
    ).lean()) as unknown as Partial<ReactorNode>;

    if (!updated) {
      throw new ApiError(`Node not found with ID ${id}`, 404);
    }

    try {
      await this.context.setValue(`REACTOR_NODE_${id}`, null);
    } catch {
      // cache clear best-effort
    }

    return updated;
  }

  async getProjects(filter?: Partial<PagedFilter>): Promise<PageReactorProjectResult> {
    // Single source of truth: the persisted project store (Mongo). This keeps
    // the id space consistent with getCatalogNodes / getProjectForCatalogNode.
    return this.projectService.getProjects(filter);
  }

  async getProject(pathSpec: string): Promise<IReactorProject> {
    if (!pathSpec) throw new ApiError('A path or id is required', 400);
    const project = await this.projectService.getProject(pathSpec);
    if (!project) throw new ApiError(`Project ${pathSpec} not found`, 404);
    return project as IReactorProject;
  }

  async catalogProject(projectSpec: Partial<IReactorProject>): Promise<Reactory.Models.ISearchable[]> {
    const { context } = this;
    const providerId = projectSpec.providerId;

    if (providerId) {
      const processorService = context.getService(providerId) as IProjectProcessor;
      if (!processorService) {
        throw new ApiError(`Processor ${providerId} not found`, 400);
      }
      // Single explicit processor path: still use a runId so GC works when this is the only processor.
      const runId = randomUUID();
      return await processorService.process(projectSpec as IReactorProject, { runId, skipGc: false });
    }

    // Auto-resolve processor(s) from project.processors or projectService
    const processorFqns: string[] = [];
    if (projectSpec.processors && projectSpec.processors.length > 0) {
      for (const p of projectSpec.processors) {
        if (p.processor) processorFqns.push(p.processor);
      }
    }

    if (processorFqns.length === 0) {
      try {
        const detected = await this.projectService.getProcessors(projectSpec as IReactorProject);
        for (const proc of detected || []) {
          if ((proc as any).processor) processorFqns.push((proc as any).processor);
        }
      } catch {
        // ignore
      }
    }

    if (processorFqns.length === 0) {
      // Nothing claimed the project: fall back to the generic file walker,
      // which still produces the folder/file tree and outlines any documents
      // it finds (document analysis lives in BaseProjectProcessor).
      processorFqns.push("reactor.FileProjectProcessor@1.0.0");
    }

    // Generate ONE shared runId for this catalog invocation so multi-processor
    // runs (e.g. NodeJS + Markdown) stamp the same runId and only the final
    // processor performs GC (Option A from session 02 plan).
    const sharedRunId = randomUUID();
    const n = processorFqns.length;
    let results: Reactory.Models.ISearchable[] = [];
    for (let i = 0; i < n; i++) {
      const fqn = processorFqns[i];
      const isLast = i === n - 1;
      try {
        const procService = context.getService(fqn) as IProjectProcessor;
        if (procService) {
          const res = await procService.process(projectSpec as IReactorProject, {
            runId: sharedRunId,
            skipGc: !isLast, // only last processor runs GC
          });
          if (res) results = results.concat(res);
        }
      } catch (err) {
        this.context.error(`catalogProject: error processing with ${fqn}: ${(err as Error).message}`);
      }
    }
    return results;
  }

  async catalogProjects(projects: Partial<IReactorProject>[]): Promise<Partial<IReactorProject>[]> {
    const processed: Partial<IReactorProject>[] = [];
    for (const project of projects) {
      try {
        await this.catalogProject(project);
        processed.push(project);
      } catch (err) {
        this.context.error(
          `catalogProject failed for ${project?.name || project?.id}: ${(err as Error).message}`
        );
      }
    }
    return processed;
  }


  async getProjectNode(project: Partial<IReactorProject>): Promise<ReactorDataNode<Partial<IReactorProject>>> {
    const processorFqn = project?.processors?.[0]?.processor;
    let provider: IProjectProcessor | null = null;
    if (processorFqn) {
      try {
        provider = this.context.getService<IProjectProcessor>(processorFqn);
      } catch (err) {
        this.context.warn(`getProjectNode: processor service "${processorFqn}" unavailable: ${(err as Error).message}`);
      }
    }
    if(provider && provider.getProjectNode) {
      try {
        return await provider.getProjectNode(project);
      } catch (err) {
        this.context.warn(`getProjectNode: provider.getProjectNode error for ${project?.name}: ${(err as Error).message}`);
      }
    } else {
      const id = nodeId(projectLogicalKey(project));
      return {
        id,
        index: id,
        key: `${id}`,
        name: project.name,
        version: project.version,
        nameSpace: project.nameSpace,
        providerId: project.processors?.[0]?.processor || 'reactor.FileProjectProcessor@1.0.0',
        source: project.repoPath,
        type: ReactorNodeType.SYSTEM,
        categories: [],
        description: project.description,
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: project,
      } as ReactorDataNode<Partial<IReactorProject>>;    
    }
  }


  async getCatalogNodes(paging?: { page?: number; pageSize?: number }): Promise<ReactorNode[]> {
    const page = paging?.page || 1;
    const pageSize = paging?.pageSize || 100;
    const pagedProjects = await this.projectService.getProjects({
      paging: {
        page,
        pageSize,
      },
      filter: {},
      search: ''
    });
    const nodes: ReactorNode[] = [];

    const promises: Promise<ReactorNode | null>[] = pagedProjects.projects.map(async (project) => { 
      try {
        const node = await this.getProjectNode(project);
        if (node) nodes.push(node);
        return node;
      } catch (err) {
        this.context.warn(`getCatalogNodes error for project ${project?.name}: ${(err as Error).message}`);
        return null;
      }
    });

    await Promise.all(promises);
    
    return nodes;
  }

  async getCatalogNode(id: number): Promise<ReactorNode> { 
    // 1. Try persisted SYSTEM/DATASTORE root
    const persisted = (await ReactorNodeModel.findOne({ id }).lean()) as unknown as ReactorNode;
    if (persisted && persisted.parentId == null) return persisted;

    // 2. Project by graphRootId
    const project = await this.projectService.getProjectByGraphRootId(id);
    if (!project) {
      throw new ApiError(`Node ${id} not found`, 404);
    }

    return this.getProjectNode(project);
  }

  /**
   * Resolves a node by id. Resolution order:
   *  1. the ephemeral node cache (populated as the tree is browsed),
   *  2. a catalog (project root) node,
   *  3. a tree walk down the ancestry `key` ("<rootId>|<childId>|...").
   *
   * The ancestry walk lazily expands each level via the owning provider, so any
   * node in the tree can be addressed even if it was never browsed before.
   */
  async getNode(id: number, key?: string): Promise<ReactorNode> {
    const { context, getChildren, getCatalogNode } = this;

    const cached = await context.getValue<ReactorNode>(`REACTOR_NODE_${id}`);
    if (cached) return cached;

    // Is this a project root?
    try {
      const rootNode = await getCatalogNode(id);
      if (rootNode) return rootNode;
    } catch {
      // Not a catalog root - fall through to the ancestry walk.
    }

    if (!key) {
      throw new ApiError(`Node ${id} not found; provide an ancestry key to walk the tree`, 404);
    }

    const ancestors = key.split('|').filter((s) => s.length > 0).map((s) => Number(s));
    if (ancestors.length === 0) {
      throw new ApiError(`Invalid ancestry key '${key}' for node ${id}`, 400);
    }

    // Walk from the root down to the target.
    let node = await getCatalogNode(ancestors[0]);
    for (let i = 1; i < ancestors.length; i++) {
      const children = await getChildren([node]);
      const next = children.find((n) => n.id === ancestors[i]);
      if (!next) {
        throw new ApiError(`Node ${ancestors[i]} not found under ${node.id}`, 404);
      }
      node = next;
    }

    if (node.id !== id) {
      context.warn(`getNode: resolved node id ${node.id} does not match requested id ${id}`);
    }

    await context.setValue(`REACTOR_NODE_${id}`, node);
    return node;
  }

  async getProjectForCatalogNode(node: Partial<ReactorNode>): Promise<Partial<IReactorProject>> {
    if (!node || (node.id === undefined && !node.name)) {
      throw new ApiError("Node is required", 400);
    }

    let project: Partial<IReactorProject> | null = null;
    if (node.id !== undefined && node.id !== null) {
      project = await this.projectService.getProjectByGraphRootId(node.id);
      if (!project && typeof node.id === "string") {
        project = await this.projectService.getProject(String(node.id));
      }
    }
    if (!project && node.name) {
      project = await this.projectService.getProject(node.name);
    }

    if (!project) {
      throw new ApiError(`Project for node ${node.name || node.id} not found`, 404);
    }

    return project;
  }
  
  async getCategoryNodes(): Promise<ReactorNodeCategory[]> {
      return DefaultReactorNodeCategories;
  }
  
  onStartup(): Promise<void> {
    return Promise.resolve();
  }
  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }
  setExecutionContext(executionContext: Reactory.Server.IReactoryContext): void {
    this.context = executionContext;
  }
  
  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}${includeVersion ? `@${this.version}` : ''}`
  }

  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;
  
}

export default SystemGraphManager;
