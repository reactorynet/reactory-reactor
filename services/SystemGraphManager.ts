import Reactory from "@reactory/reactory-core";
import ApiError from "@reactory/server-core/exceptions";

import { IReactorProject, IProjectProcessor, ISystemGraphManager, PageReactorProjectResult } from "../types/service.types"
import Hash from "@reactory/server-core/utils/hash";
import { ReactorDataNode, ReactorNode, ReactorNodeCategory, ReactorNodeLink, ReactorNodeType } from "../types/model.types";
import { DefaultReactorNodeCategories } from '../models/ReactorGraphNode';

import { 
  getReactorProjectCatalogs
} from '../data'

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

class SystemGraphManager implements ISystemGraphManager {
  
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;

  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;
  searchService: Reactory.Service.ISearchService;
  
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
    
    const promises = parents.map((parent) => {
      const provider = context.getService<IProjectProcessor>(parent.providerId);
      if(provider) {
        return provider.getChildrenForNode(parent, parent.key, null, null);
      }
    });

    const results = await Promise.all(promises);
    results.forEach((result) => {
      children.push(...result);
    });

    return children;
  }
  getLinks(sources: ReactorNode[], types: string[], targets: ReactorNode[]): Promise<ReactorNodeLink[]> {
    throw new Error("Method not implemented.");
  }
  createLink(source: ReactorNode, type: string, target: ReactorNode): Promise<ReactorNodeLink> {
    throw new Error("Method not implemented.");
  }
  updateLink(link: ReactorNodeLink): Promise<ReactorNodeLink> {
    throw new Error("Method not implemented.");
  }
  deleteLink(link: ReactorNodeLink): Promise<ReactorNodeLink> {
    throw new Error("Method not implemented.");
  }

  async getProjects(): Promise<PageReactorProjectResult> {
    const projects = await getReactorProjectCatalogs(this.context);
     const results: PageReactorProjectResult = { 
      projects: projects,
      paging: {
        hasNext: false,
        page: 1,
        pageSize: projects.length,
        total: projects.length
      }
     }

     return results;
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

  catalogProjects(projects: Partial<IReactorProject>[]): Promise<Partial<IReactorProject>[]> {  
    const that = this;

    projects.forEach((project) => {
      that.catalogProject(project);
    });

    return Promise.resolve(projects);
  } 


  async getProjectNode(project: Partial<IReactorProject>): Promise<ReactorDataNode<Partial<IReactorProject>>> {
    const provider = this.context.getService<IProjectProcessor>(project.providerId);
    if(provider && provider.getProjectNode) {
      return await provider.getProjectNode(project);      
    } else {
      return {
        id: project.id,
        index: Hash(project.id),
        key: `${project.id}`,
        name: project.name,
        version: project.version,
        nameSpace: project.nameSpace,
        providerId: project.providerId,
        source: project.source,
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
    const projects = await getReactorProjectCatalogs(this.context);
    const nodes: ReactorNode[] = [];

    const promises: Promise<ReactorNode>[] = projects.map(async (project) => { 
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

  async getNode(id: number, key: string): Promise<ReactorNode> {
    // check the cache
    const { context, getChildren, getCatalogNode } = this;
    const cached = await context.getValue<ReactorNode>(`REACTOR_NODE_${id}`);

    if(!cached) {

      //get the root node from catalog nodes
      let rootNode = await getCatalogNode(id);

      if(rootNode) return rootNode;
      
      if(!rootNode && !key) {
        throw new ApiError(`Root Node ${id} not found, provide a key to search using tree`, 400);
      }
      // if not in cache, get from the catalog
      // use the key path to get the node
      if(key) {
        let ancestors = key.split('|');
        let root = ancestors.shift(); 
        
        rootNode = await getCatalogNode(parseInt(root));

        let node = rootNode;
        let children = await getChildren([node]);
        while(ancestors.length > 0) {
          const next = ancestors.shift();
          node = children.find((n) => n.id === Number(next));
          if(!node) {
            throw new ApiError(`Node ${next} not found`, 400);
          }
          children = await getChildren([node]);
        }

        return node;

      }
    } 
    return cached;  
  }

  async getProjectForCatalogNode(node: Partial<ReactorNode>): Promise<Partial<IReactorProject>> {
    const projects = await getReactorProjectCatalogs(this.context);
    const project = projects.find((p) => p.id === node.id);

    if(!project) {
      throw new ApiError(`Project ${node.name} not found`, 400);
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
    return `${SystemGraphManager.reactory.nameSpace}.${SystemGraphManager.reactory.name}${includeVersion ? `@${SystemGraphManager.reactory.version}` : ''}`
  }

  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;

  static reactory: Reactory.Service.IReactoryServiceDefinition<SystemGraphManager> = {
    name: "SystemGraphManager",
    nameSpace: "reactor",
    version: "1.0.0",
    description: "Service for catalogging and creating a graph for a given system",
    id: "reactor.SystemGraphManager@1.0.0",
    serviceType: "data",
    service(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
      return new SystemGraphManager(props, context);
    },    
    dependencies: [
      { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },      
      { id: "core.FetchService@1.0.0", alias: "fetchService" },
      { id: "core.ReactorySearchService@1.0.0", alias: "searchService"}
    ],
  };
  
}

export default SystemGraphManager.reactory;
