import {
  mutation,
  query,
  resolver,
  property,
} from "@reactory/server-core/models/graphql/decorators/resolver";

import {
  AttributeProvider,
  IProjectProcessor,
  IReactorProject,
  IReactorProjectMetrics,
  IReactorProjectPathSpec,
  ISystemGraphManager,
  PageReactorProjectResult,
  ReactorNodeAttributes,
  ReactorProjectDocumentation,
  ReactorProjectService,
  ReactorProjectStatus,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ObjectId } from "mongodb";
import {
  PagingRequest,
  PagingResult,
} from "@reactory/server-core/database/types";
import {
  ReactorNode,
  ReactorNodeType,
  ReactorNodeCategory,
} from "@reactory/server-modules/reactory-reactor/types/model.types";

import OBJID from "@reactory/server-core/utils/ObjectId";

interface PagedNodes {
  nodes: Partial<ReactorNode>[];
  paging: PagingResult;
}

interface PagedCategoryNodes {
  nodes: Partial<ReactorNodeCategory>[];
  paging: PagingResult;
}

interface ReactorProjectFilterArgs {
  search: string;
  ownerTeam: string;
  owner: string;
  system: string;
  businessUnit: string;
  status: string;
  ids: string[];
  paging: PagingRequest;
}

interface CatalogNodeSyncSuccess {
  node: Partial<ReactorNode>;
  message: string;
}

interface CatalogNodeSyncFailure {
  node: Partial<ReactorNode>;
  errors: string[];
}

type CatalogNodeSyncResult = CatalogNodeSyncSuccess | CatalogNodeSyncFailure;


interface ReactorNodeCatalogIndexSuccess {
  __typename: "ReactorNodeCatalogIndexSuccess"
  nodes: Partial<ReactorNode>[]
  message: string
}

interface ReactorNodeCatalogIndexFailure {
  __typename: "ReactorNodeCatalogIndexFailure"
  errors: string[]
}


type ReactorNodeCatalogIndexResult = ReactorNodeCatalogIndexSuccess | 
  ReactorNodeCatalogIndexFailure

//@ts-ignore
@resolver
class ReactorSystemGraph {
  resolver: any;

  @query("ReactorNodesByNameAndNameSpace")
  async ReactorNodesByNameAndNameSpace(
    _: any,
    args: {
      nameSpace: string;
      name: string;
      term?: string;
      paging: PagingRequest;
    },
    context: Reactory.Server.IReactoryContext
  ): Promise<PagedNodes> {
    const nodes: Partial<ReactorNode>[] = [];
    const { name, nameSpace, term } = args;
    let paging = args.paging || { page: 0, pageSize: 10 };
    const searchSvc = context.getService<Reactory.Service.ISearchService>(
      "core.ReactorySearchService@1.0.0"
    );
    const offset = (paging.page === 0 ? 1 : paging.page) * paging.pageSize;
    const searchResults = await searchSvc.search<
      Partial<Reactory.Models.ISearchable>
    >(
      `reactor_graph_${nameSpace}_${name}`,
      term,
      ["name", "nameSpace", "description"],
      paging.pageSize,
      offset
    );
    searchResults.results.forEach((r) => {
      nodes.push({
        id: context.utils.hash(r.id),
        index: r.id,
        name: r.name,
        version: r.version,
        nameSpace: r.nameSpace,
        type: ReactorNodeType.DATASTORE,
        categories: [],
        description: r.source,
        created: new Date(),
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        updated: new Date(),
      });
    });

    return {
      nodes,
      paging: {
        total: searchResults.total,
        hasNext: offset + paging.pageSize < searchResults.total,
        page: paging.page,
        pageSize: paging.pageSize,
      },
    };
  }

  @query("ReactorNode")
  async ReactorNodeById(
    _: any,
    args: { id: number, ancestry: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    return graphSvc.getNode(args.id, args.ancestry);    
  }

  @property("ReactorNode", "children")
  async getChildrenForNode(
    node: Partial<ReactorNode>,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );

    if(node && node.id) { 
      return graphSvc.getChildren([node] as ReactorNode[]);
    } else {
      context.warn("No node id provided for getChildrenForNode")
    }
    
    return [];
  }

  @query("ReactorNodeCategories")
  async ReactorNodeCategories(
    _: any,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory>[]> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    return graphSvc.getCategoryNodes();
  }

  @property("ReactorProject", "id")
  getProjectId(project: IReactorProject) {
    return project._id.toString();
  }

  @property("ReactorProject", "fqn")
  getProjectFQN(project: IReactorProject) {
    return `${project.nameSpace}.${project.name}@${project.version || "1.0.0"}`;
  }

  @property("ReactorProject", "repoUrl")
  getProjectRepoUrl(project: IReactorProject, args: any, context: Reactory.Server.IReactoryContext): string {
    if (project.repoUrl) {
      return project.repoUrl;
    }
    const DEFAULT_URL = `https://github.com/${project.nameSpace}/${project.name}.git`
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    
    return projectSvc?.getRepoUrl(project) || DEFAULT_URL;    
  }

  @property("ReactorProject", "tasksUrl")
  getProjectTasksUrl(project: IReactorProject, args: any, context: Reactory.Server.IReactoryContext): string {
    if (project.tasksUrl) {
      return project.tasksUrl;
    }
    return process.env.DEFAULT_TASKS_URL || `/reactor/service/${project.name}?tab=tasks&action=setUrl`;
  }

  @property("ReactorProject", "primaryDocumentation")
  async getProjectPrimaryDocument(project: Partial<IReactorProject>, args: any, context: Reactory.Server.IReactoryContext): Promise<ReactorProjectDocumentation> {    
    // we check if the project has a repoPath if it does, we search the folder for the first readme.md 
    if (project.repoPath) {
      const projectSvc = context.getService<ReactorProjectService>(
        "reactor.ReactorProjectService@1.0.0"
      );
      return projectSvc.getPrimaryDocumentation(project);
    } else {
      return {
        id: 0,
        title: "No Documentation",
        content: "This project does not have any documentation available.",
        format: "text",
        created: new Date(),
        createdBy: context.user
      };
    }
  }

  @property("ReactorProject", "additionalDocumentation")
  async getProjectAdditionalDocuments(
    project: Partial<IReactorProject>,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorProjectDocumentation[]> {
    // we check if the project has a repoPath if it does, we search the folder for the first readme.md 
    if (project.repoPath) {
      const projectSvc = context.getService<ReactorProjectService>(
        "reactor.ReactorProjectService@1.0.0"
      );
      return projectSvc.getAdditionalDocumentation(project);
    } else {
      return [];
    }
  }

  @property("ReactorProject", "projectMetrics")
  async getProjectMetrics(
    project: Partial<IReactorProject>,
    args: { startDate?: Date; endDate?: Date; metrics?: string[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<IReactorProjectMetrics[]> {
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    return projectSvc.getProjectMetrics(project, args.startDate, args.endDate);
  }

  @query("ReactorCatalogNodes")
  async ReactorCatalogNodes(
    _: any,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<PagedNodes> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    const nodes = await graphSvc.getCatalogNodes();
    return {
      paging: {
        total: nodes.length,
        hasNext: false,
        page: 0,
        pageSize: nodes.length,
      },
      nodes,
    };
  }

  @query("ReactorProjects")
  async ReactorProjects(
    _: any,
    args: { filter: ReactorProjectFilterArgs },
    context: Reactory.Server.IReactoryContext
  ): Promise<PageReactorProjectResult> {
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    return projectSvc.getProjects(args.filter);
  }

  @property("ReactorProjectPathSpec", "id")
  getProjectPathSpecId({ id, path, filter, type }: IReactorProjectPathSpec) {
    if (id && typeof id === 'object' && id.constructor?.name === 'ObjectId') return id;
    if (id) return new ObjectId(id);

    return OBJID.deterministicObjectId(
      `${path || "\\"}-${filter || "*"}-${type || "file"}`
    );
  }

  @property("ReactorProjectPathSpec", "filter")
  getProjectPathSpecFilter({ filter }: IReactorProjectPathSpec) {
    return filter || "*";
  }

  @property("ReactorProjectPathSpec", "type")
  getProjectPathSpecType({ type }: IReactorProjectPathSpec) {
    return type || "file";
  }

  @property("ReactorNode", "attributes")
  getNodeAttributes(
    node: ReactorNode,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorNodeAttributes[]> {
    if (node.providerId) {
      const provider = context.getService<AttributeProvider>(node.providerId);
      if (provider) {
        return provider.getAttributes(node);
      }
    } else {
      return Promise.resolve([]);
    }
  }

  @property("ReactorProject", "files")
  getProjectFileSpecs(project: IReactorProject, _: any, context: Reactory.Server.IReactoryContext) { 
    if(project.providerId) {
      const provider = context.getService<IProjectProcessor>(project.providerId);
      if(provider && provider.getFileSpecs) {
        return provider.getFileSpecs(project);
      }
    }
    return [];
  }

  @property("ReactorProject", "projectStatus")
  getProjectStatus(
    project: IReactorProject,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): ReactorProjectStatus {
   
   return project?.projectStatus || ReactorProjectStatus.ACTIVE;
  }



  @mutation("ReactorSyncCatalogNode")
  async syncCatalogNode(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<CatalogNodeSyncResult> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    try {
      const project = await graphSvc.getProjectForCatalogNode({ id: args.id });
      if (project) {
        await graphSvc.catalogProject(project);
      }

      return {
        node: await graphSvc.getCatalogNode(args.id),
        message: "Catalog node sync complete",
      };
    } catch (e) {
      return {
        node: await graphSvc.getCatalogNode(args.id),
        errors: [e.message],
      };
    }
  }

  @mutation("ReactorIndexCatalogNodes")
  async indexCatalogNodes(
    _: any,
    args: { ids: number[] },
    context: Reactory.Server.IReactoryContext): 
      Promise<ReactorNodeCatalogIndexResult> {
       
      if(!args || args?.ids.length === 0)  {
        return {
          __typename: "ReactorNodeCatalogIndexFailure",
          errors: ["Process requires at least one node id to begin processing"]
        }
      }

      const graphSvc = context.getService<ISystemGraphManager>("reactor.SystemGraphManager@1.0.0");
      const projectNode = await graphSvc.getCatalogNode(args.ids[0]);
      
      if(projectNode) {
        const catalogResult = await graphSvc.catalogProject(projectNode.data);
        if(catalogResult && catalogResult.length > 0) {
          return {
            __typename: "ReactorNodeCatalogIndexSuccess", 
            nodes: [projectNode],
            message: "Catalog Node has been indexed",
          }
        } else {
          return {
            __typename: "ReactorNodeCatalogIndexFailure",
            errors: ["Catalog yielded no searchable results"]
          }  
        }
      } else {
        return {
          __typename: "ReactorNodeCatalogIndexFailure",
          errors: [`Catalog node with id: [${args.ids[0]}]`]
        }
      }
      
      
  }

  @query("ReactorNodeCategory")
  async ReactorNodeCategory(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory> | undefined> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    // Filter from getCategoryNodes
    const categories = await graphSvc.getCategoryNodes();
    return categories.find((cat) => cat.id === args.id);
  }

  @query("ReactorNodeByCategory")
  async ReactorNodeByCategory(
    _: any,
    args: { ids: number[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    // Not directly supported, so filter nodes by category ids
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    const allNodes = await graphSvc.getCatalogNodes();
    return allNodes.filter((node) =>
      node.categories && node.categories.some((cat) => args.ids.includes(cat.id))
    );
  }

  @query("ReactorNodesForType")
  async ReactorNodesForType(
    _: any,
    args: { type: string[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    // Not directly supported, so filter nodes by type
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    const allNodes = await graphSvc.getCatalogNodes();
    return allNodes.filter((node) => args.type.includes(node.type));
  }

  @query("ReactorNodesByTerm")
  async ReactorNodesByTerm(
    _: any,
    args: { term: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    // Not directly supported, so filter nodes by term in name, description, etc.
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    const allNodes = await graphSvc.getCatalogNodes();
    const term = args.term.toLowerCase();
    return allNodes.filter((node) =>
      (node.name && node.name.toLowerCase().includes(term)) ||
      (node.description && node.description.toLowerCase().includes(term))
    );
  }

  @query("ReactorProject")
  async ReactorProject(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<IReactorProject> | undefined> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    const projects = (await graphSvc.getProjects()).projects;
    return projects.find((p) => p.id === args.id);
  }

  @mutation("ReactorCrawlCatalogNodes")
  async ReactorCrawlCatalogNodes(
    _: any,
    args: { request: { ids: number[] } },
    context: Reactory.Server.IReactoryContext
  ): Promise<CatalogNodeSyncResult[]> {
    // Not implemented in SystemGraphManager
    throw new Error("crawlCatalogNodes not implemented");
  }

  @mutation("ReactorNodeCategoryCreate")
  async ReactorNodeCategoryCreate(
    _: any,
    args: { name: string; description?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory>> {
    // Not implemented in SystemGraphManager
    throw new Error("createNodeCategory not implemented");
  }

  @mutation("ReactorNodeCategoryUpdate")
  async ReactorNodeCategoryUpdate(
    _: any,
    args: { id: number; name?: string; description?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory>> {
    // Not implemented in SystemGraphManager
    throw new Error("updateNodeCategory not implemented");
  }

  @mutation("ReactorNodeCategoryDelete")
  async ReactorNodeCategoryDelete(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory>> {
    // Not implemented in SystemGraphManager
    throw new Error("deleteNodeCategory not implemented");
  }

  @mutation("ReactorNodeCreate")
  async ReactorNodeCreate(
    _: any,
    args: { nameSpace: string; name: string; version: string; description?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    // Not implemented in SystemGraphManager
    throw new Error("createNode not implemented");
  }

  @mutation("ReactorNodeUpdate")
  async ReactorNodeUpdate(
    _: any,
    args: { id: number; nameSpace?: string; name?: string; version?: string; description?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<PagedNodes> {
    // Not implemented in SystemGraphManager
    throw new Error("updateNode not implemented");
  }

  @mutation("ReactorNodeDelete")
  async ReactorNodeDelete(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    // Not implemented in SystemGraphManager
    throw new Error("deleteNode not implemented");
  }

  @mutation("ReactorNodeLinkCreate")
  async ReactorNodeLinkCreate(
    _: any,
    args: { createInput: any },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    // Not implemented in SystemGraphManager
    throw new Error("createNodeLink not implemented");
  }

  @mutation("ReactorNodeLinkDelete")
  async ReactorNodeLinkDelete(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    // Not implemented in SystemGraphManager
    throw new Error("deleteNodeLink not implemented");
  }

  @mutation("ReactorNodeLinkUpdate")
  async ReactorNodeLinkUpdate(
    _: any,
    args: { updateInput: any },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    // Not implemented in SystemGraphManager
    throw new Error("updateNodeLink not implemented");
  }

  @mutation("ReactorSaveSystemGraph")
  async ReactorSaveSystemGraph(
    _: any,
    args: { graph: any[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    // Not implemented in SystemGraphManager
    throw new Error("saveSystemGraph not implemented");
  }

  @query("ReactorProjectByName")
  async ReactorProjectByName(
    _: any,
    args: { name: string; nameSpace?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<IReactorProject> | undefined> {
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    const pagedProjects = await projectSvc.getProjects({
      comparitor: {
        name: args.name
      }
    });

    if (pagedProjects.paging.total >= 1) {
      return pagedProjects.projects[0];
    }
  }

  @mutation("ReactorUpdateProject")
  async ReactorUpdateProject(
    _: any,
    args: { projectId: string; updates: any },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    try {
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    const result = await projectSvc.updateProject(args.projectId, args.updates);
    if(result) {
      return {
        __typename: "ReactorProjectUpdateSuccess",
        id: result._id.toString(),
        project: result,
        message: "Project updated successfully"
      };
    } else {
      return {
        __typename: "ReactorProjectUpdateFailure",
          id: args.projectId,
          error: "Failed to update project"
        };
      }
    } catch (error) {
      context.error("Error updating project", { error, projectId: args.projectId });
      return {
        __typename: "ReactorProjectUpdateFailure",
        error: error.message || "An error occurred while updating project",
        id: args.projectId
      };
    }
  }

  @mutation("ReactorUpdateProjectDocumentation")
  async ReactorUpdateProjectDocumentation(
    _: any,
    args: { projectId: string; additionalDocumentation: any[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    try {
      const projectSvc = context.getService<ReactorProjectService>(
        "reactor.ReactorProjectService@1.0.0"
      );
      
      // Get the current project
      const project = await projectSvc.getProject(args.projectId);
      if (!project) {
        return {
          __typename: "ReactorProjectDocumentationUpdateFailure",
          error: "Project not found"
        };
      }

      // Update the project with new additional documentation
      const updatedProject = await projectSvc.updateProject(args.projectId, {
        secondaryDocumentation: args.additionalDocumentation
      });

      if (updatedProject) {
        return {
          __typename: "ReactorProjectDocumentationUpdateSuccess",
          project: updatedProject,
          message: "Project documentation updated successfully"
        };
      } else {
        return {
          __typename: "ReactorProjectDocumentationUpdateFailure",
          error: "Failed to update project documentation"
        };
      }
    } catch (error) {
      context.error("Error updating project documentation", { error, projectId: args.projectId });
      return {
        __typename: "ReactorProjectDocumentationUpdateFailure",
        error: error.message || "An error occurred while updating project documentation"
      };
    }
  }
}

export default ReactorSystemGraph;
