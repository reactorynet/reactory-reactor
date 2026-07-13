import Reactory from "@reactorynet/reactory-core";
import ApiError from "@reactory/server-core/exceptions";

import { IReactorProject, IProjectProcessor, ISystemGraphManager, PagedFilter, PageReactorProjectResult, ReactorProjectService } from "../types/service.types"
import Hash from "@reactory/server-core/utils/hash";
import { ReactorDataNode, ReactorNode, ReactorNodeCategory, ReactorNodeLink, ReactorLinkType, ReactorNodeType } from "../types/model.types";
import { DefaultReactorNodeCategories } from '../models/ReactorGraphNode';
import { ReactorNodeLinkModel } from '../models/ReactorNodeLink';
import { linkId, nodeId, projectLogicalKey } from './graph/GraphIdentity';
import { service } from "@reactory/server-core/application/decorators";

const kvp = {
  "tsql": ReactorNodeType.DATASTORE,
  "java": ReactorNodeType.SYSTEM,
  "csharp": ReactorNodeType.SYSTEM,
  "javascript": ReactorNodeType.SYSTEM,
  "typescript": ReactorNodeType.SYSTEM,
  "python": ReactorNodeType.SYSTEM,
  "react-web": ReactorNodeType.CONSUMER,  
  "react-native": ReactorNodeType.CONSUMER,
}

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
    this.createLink = this.createLink.bind(this);
    this.updateLink = this.updateLink.bind(this);
    this.deleteLink = this.deleteLink.bind(this);
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
        $setOnInsert: { id, created: now },
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

  async getProjects(filter?: Partial<PagedFilter>): Promise<PageReactorProjectResult> {
    // Single source of truth: the persisted project store (Mongo). This keeps
    // the id space consistent with getCatalogNodes / getProjectForCatalogNode.
    return this.projectService.getProjects(filter);
  }

  getProject(pathSpec: string): Promise<IReactorProject> {
    // if (!pathSpec) {
    //   throw new ApiError('A path is required to create a project', 400);
    // }

    // if(fs.existsSync(pathSpec)) {

    //   const project: Partial<IReactorProject> = {
    //     pathSpecs: [
    //       {
    //         path: path.join(pathSpec, 'Tables'),
    //         filter: '.sql',
    //         type: 'Table',
    //         id: '',
    //       },
    //       {
    //         path: path.join(pathSpec, 'Views'),
    //         filter: '.sql',
    //         type: 'View',
    //         id: '',
    //       },
    //       {
    //         path: path.join(pathSpec, 'Stored Procedures'),
    //         filter: '.sql',
    //         type: 'Stored Procedure',
    //         id: '',
    //       },
    //       {
    //         path: path.join(pathSpec, 'Functions'),
    //         filter: '.sql',
    //         type: 'Function',
    //         id: '',
    //       },
    //     ],
    //     providerId: 'reactor.TSqlProjectProcessor@1.0.0',
    //   }
    //   return Promise.resolve(project as IReactorProject);
    // } else {
    //   throw new ApiError(`Path ${pathSpec} does not exist`, 400);
    // }
    throw new Error("Method not implemented.");
  }

  async catalogProject(projectSpec: Partial<IReactorProject>): Promise<Reactory.Models.ISearchable[]> {
    const that = this    
    const { context, props } = this;

    const { 
      name, 
      nameSpace, 
      version,
      providerId, 
    } = projectSpec;

    if(!providerId) {
      throw new ApiError('A providerId is required to process a project', 400);
    }

    const processorService = context.getService(providerId) as IProjectProcessor;
    if (!processorService) {
      throw new ApiError(`Processor ${providerId} not found`, 400);
    }

    return await processorService.process(projectSpec as IReactorProject);
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
    const provider = this.context.getService<IProjectProcessor>(project?.processors?.[0]?.processor);
    if(provider && provider.getProjectNode) {
      return await provider.getProjectNode(project);
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


  async getCatalogNodes(): Promise<ReactorNode[]> {
    const that = this;
    const pagedProjects = await this.projectService.getProjects({
      paging: {
        page: 1,
        pageSize: 1000
      },
      filter: {},
      search: ''
    });
    const nodes: ReactorNode[] = [];

    const promises: Promise<ReactorNode>[] = pagedProjects.projects.map(async (project) => { 
      const node = await that.getProjectNode(project);
      nodes.push(node);
      return node;
    })

    await Promise.all(promises);
    
    return nodes;
  }

  async getCatalogNode(id: number): Promise<ReactorNode> { 
    const allNodes = await this.getCatalogNodes();
    const node = allNodes.find((n) => n.id === id);
    if(!node) {
      throw new ApiError(`Node ${id} not found`, 400);
    }

    return node;
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
    // Map a catalog node id back to its project. Node ids are the deterministic
    // hash of the project's logical key, so match on that rather than assuming
    // node.id equals the raw project id.
    const { projects } = await this.projectService.getProjects({
      paging: { page: 1, pageSize: 1000 },
    });
    const project = projects.find(
      (p) => nodeId(projectLogicalKey(p)) === node.id || `${p.id}` === `${node.id}`
    );

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
