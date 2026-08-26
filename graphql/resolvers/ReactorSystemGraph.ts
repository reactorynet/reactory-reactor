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
  ReactorNodeLink,
  ReactorLinkType,
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

/**
 * Module-level helpers — the @query/@mutation/@property decorators copy
 * UNBOUND function references into the resolver map (see mergeResolver.ts),
 * so `this` inside a decorated method is Apollo's field object, never the
 * class instance. Shared logic must live outside the class.
 */
const graphService = (context: Reactory.Server.IReactoryContext): ISystemGraphManager =>
  context.getService<ISystemGraphManager>("reactor.SystemGraphManager@1.0.0");

function normalizePaging(
  paging?: PagingRequest,
  defaultPageSize: number = 25,
  maxPageSize: number = 500
): { page: number; pageSize: number; skip: number } {
  const page = Math.max(paging?.page || 1, 1);
  const pageSize = Math.min(Math.max(paging?.pageSize || defaultPageSize, 1), maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * Resolve a node by its deterministic id. Delegates to the graph façade,
 * which checks the persisted graph, then the lazy tree cache, and returns a
 * minimal placeholder if neither has it (so non-null edge endpoints never
 * crash the query).
 */
const resolveNodeById = async (
  id: number,
  context: Reactory.Server.IReactoryContext
): Promise<Partial<ReactorNode>> => {
  const [node] = await graphService(context).getNodes([id]);
  return node;
};

const relatedNodes = async (
  node: Partial<ReactorNode>,
  context: Reactory.Server.IReactoryContext,
  direction: "dependencies" | "dependents",
  types?: string[]
): Promise<Partial<ReactorNode>[]> => {
  if (!node?.id) return [];
  const graphSvc = graphService(context);
  const edges = await graphSvc.getNodeLinks([node.id], {
    direction: direction === "dependencies" ? "out" : "in",
    types,
  });
  const ids = edges.map((e) =>
    direction === "dependencies" ? e.target : e.source
  );
  const unique = Array.from(new Set(ids));
  return graphSvc.getNodes(unique);
};

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
    const { name, nameSpace, term } = args;
    const { page, pageSize } = normalizePaging(args.paging, 10, 500);
    const graphSvc = graphService(context);
    const nodes = await graphSvc.searchNodes(term || "", {
      nameSpace,
      name,
      limit: pageSize,
    });

    return {
      nodes,
      paging: {
        total: nodes.length,
        hasNext: false,
        page,
        pageSize,
      },
    };
  }

  @query("ReactorNode")
  async ReactorNodeById(
    _: any,
    args: { id: number; key?: string; ancestry?: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    return graphService(context).getNode(args.id, args.key || args.ancestry);
  }

  @property("ReactorNode", "dependencies")
  async getNodeDependencies(
    node: Partial<ReactorNode>,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return relatedNodes(node, context, "dependencies", [
      ReactorLinkType.DEPENDENCY,
    ]);
  }

  @property("ReactorNode", "dependents")
  async getNodeDependents(
    node: Partial<ReactorNode>,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return relatedNodes(node, context, "dependents", [
      ReactorLinkType.DEPENDENCY,
    ]);
  }

  @property("ReactorNode", "inputs")
  async getNodeInputs(
    node: Partial<ReactorNode>,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return relatedNodes(node, context, "dependents", [ReactorLinkType.INPUT]);
  }

  @property("ReactorNode", "outputs")
  async getNodeOutputs(
    node: Partial<ReactorNode>,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return relatedNodes(node, context, "dependencies", [ReactorLinkType.OUTPUT]);
  }

  @property("ReactorNode", "parent")
  async getNodeParent(
    node: Partial<ReactorNode>,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode> | null> {
    if (node?.parentId === undefined || node?.parentId === null) return null;
    return resolveNodeById(node.parentId, context);
  }

  @property("ReactorNodeLink", "source")
  async getLinkSource(
    link: ReactorNodeLink,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    return resolveNodeById(link.source, context);
  }

  @property("ReactorNodeLink", "target")
  async getLinkTarget(
    link: ReactorNodeLink,
    _: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    return resolveNodeById(link.target, context);
  }

  @property("ReactorNodeLink", "sourceId")
  getLinkSourceId(link: ReactorNodeLink): number {
    return link.sourceId ?? (link as any).source;
  }

  @property("ReactorNodeLink", "targetId")
  getLinkTargetId(link: ReactorNodeLink): number {
    return link.targetId ?? (link as any).target;
  }

  @property("ReactorNode", "nodeId")
  getNodeId(node: Partial<ReactorNode>): number {
    if (node.nodeId !== undefined && node.nodeId !== null) return node.nodeId;
    if (node.index !== undefined && node.index !== null) return node.index;
    if (typeof node.id === 'number') return node.id;
    const parsed = parseInt(String(node.id), 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  @property("ReactorNode", "index")
  getNodeIndex(node: Partial<ReactorNode>): number {
    if (node.index !== undefined && node.index !== null) return node.index;
    if (node.nodeId !== undefined && node.nodeId !== null) return node.nodeId;
    if (typeof node.id === 'number') return node.id;
    const parsed = parseInt(String(node.id), 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  @property("ReactorNode", "links")
  async getNodeLinks(
    node: Partial<ReactorNode>,
    args: { direction?: "IN" | "OUT" | "BOTH"; types?: string[]; limit?: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorNodeLink[]> {
    if (!node?.id) return [];
    return graphService(context).getNodeLinks([node.id], {
      direction: (args.direction?.toLowerCase() as "in" | "out" | "both") || "both",
      types: args.types,
      limit: args.limit,
    });
  }

  @query("ReactorNodes")
  async ReactorNodes(
    _: any,
    args: { ids: number[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    const ids = (args.ids || []).slice(0, 500);
    return graphService(context).getNodes(ids);
  }

  @query("ReactorNodeLinks")
  async ReactorNodeLinks(
    _: any,
    args: {
      sources?: number[];
      targets?: number[];
      types?: string[];
      projectId?: string;
      paging?: PagingRequest;
    },
    context: Reactory.Server.IReactoryContext
  ): Promise<{ links: ReactorNodeLink[]; paging: PagingResult }> {
    return graphService(context).findLinks(args);
  }

  @query("ReactorSubgraph")
  async ReactorSubgraph(
    _: any,
    args: {
      rootId: number;
      depth?: number;
      direction?: "IN" | "OUT" | "BOTH";
      nodeTypes?: string[];
      linkTypes?: string[];
      limit?: number;
      includeContainment?: boolean;
      materialize?: boolean;
    },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    const subgraph = await graphService(context).getSubgraph(args.rootId, {
      depth: args.depth,
      direction: (args.direction?.toLowerCase() as "in" | "out" | "both") || "both",
      nodeTypes: args.nodeTypes,
      linkTypes: args.linkTypes,
      limit: args.limit,
      includeContainment: args.includeContainment,
      materialize: args.materialize,
    });
    return {
      ...subgraph,
      nodeCount: subgraph.stats?.nodeCount ?? subgraph.nodes.length,
      linkCount: subgraph.stats?.linkCount ?? subgraph.links.length,
      depthReached: subgraph.stats?.depthReached ?? 0,
    };
  }

  @query("ReactorGraphPath")
  async ReactorGraphPath(
    _: any,
    args: { sourceId: number; targetId: number; maxDepth?: number; linkTypes?: string[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<{ found: boolean; nodes: Partial<ReactorNode>[]; links: ReactorNodeLink[] }> {
    const graphSvc = graphService(context);
    const path = await graphSvc.findPath(args.sourceId, args.targetId, {
      maxDepth: args.maxDepth,
      linkTypes: args.linkTypes,
    });
    const nodes = path.found ? await graphSvc.getNodes(path.nodeIds) : [];
    return { found: path.found, nodes, links: path.links };
  }

  @property("ReactorNode", "children")
  async getChildrenForNode(
    node: Partial<ReactorNode>,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    if (node && node.id) { 
      return graphService(context).getChildren([node] as ReactorNode[]);
    } else {
      context.warn("No node id provided for getChildrenForNode");
    }
    
    return [];
  }

  @query("ReactorNodeCategories")
  async ReactorNodeCategories(
    _: any,
    args: any,
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory>[]> {
    return graphService(context).getCategoryNodes();
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
    args: { paging?: PagingRequest },
    context: Reactory.Server.IReactoryContext
  ): Promise<PagedNodes> {
    const { page, pageSize } = normalizePaging(args?.paging, 100, 500);
    const graphSvc = graphService(context);
    const nodes = await graphSvc.getCatalogNodes({ page, pageSize });
    return {
      paging: {
        total: nodes.length,
        hasNext: false,
        page,
        pageSize,
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



  @mutation("ReactorSyncCatalogNodes")
  async syncCatalogNodes(
    _: any,
    args: { request: { ids: number[] } },
    context: Reactory.Server.IReactoryContext
  ): Promise<CatalogNodeSyncResult[]> {
    const graphSvc = graphService(context);
    const ids = args?.request?.ids || [];
    const results: CatalogNodeSyncResult[] = [];
    for (const id of ids) {
      try {
        const project = await graphSvc.getProjectForCatalogNode({ id });
        if (project) await graphSvc.catalogProject(project);
        results.push({
          node: await graphSvc.getCatalogNode(id),
          message: "Catalog node sync complete",
        });
      } catch (e) {
        let node: Partial<ReactorNode> = { id } as Partial<ReactorNode>;
        try {
          node = await graphSvc.getCatalogNode(id);
        } catch {
          /* node may not resolve if project missing */
        }
        results.push({ node, errors: [(e as Error).message] });
      }
    }
    return results;
  }

  @mutation("ReactorIndexNodes")
  async indexNodes(
    _: any,
    args: { filter: ReactorProjectFilterArgs },
    context: Reactory.Server.IReactoryContext
  ): Promise<PagedNodes> {
    const graphSvc = graphService(context);
    const projectSvc = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );

    const { projects } = await projectSvc.getProjects(args.filter);
    for (const project of projects) {
      try {
        await projectSvc.index(project as IReactorProject);
      } catch (e) {
        context.error(
          `Failed to index project ${project.name}: ${(e as Error).message}`
        );
      }
    }

    const nodes = await graphSvc.getCatalogNodes();
    return {
      nodes,
      paging: {
        total: nodes.length,
        hasNext: false,
        page: 1,
        pageSize: nodes.length,
      },
    };
  }

  @query("ReactorNodeCategory")
  async ReactorNodeCategory(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNodeCategory> | undefined> {
    const categories = await graphService(context).getCategoryNodes();
    return categories.find((cat) => cat.id === args.id);
  }

  @query("ReactorNodeByCategory")
  async ReactorNodeByCategory(
    _: any,
    args: { ids: number[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return graphService(context).findNodesByCategory(args.ids);
  }

  @query("ReactorNodesForType")
  async ReactorNodesForType(
    _: any,
    args: { type: string[] },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return graphService(context).findNodesByType(args.type);
  }

  @query("ReactorNodesByTerm")
  async ReactorNodesByTerm(
    _: any,
    args: { term: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>[]> {
    return graphService(context).searchNodes(args.term || "", { limit: 100 });
  }

  @query("ReactorProject")
  async ReactorProject(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<IReactorProject> | undefined> {
    const projectService = context.getService<ReactorProjectService>(
      "reactor.ReactorProjectService@1.0.0"
    );
    // getProject resolves by ObjectId string, FQN, name or repo path.
    return projectService.getProject(args.id);
  }

  @mutation("ReactorCreateNodeLink")
  async ReactorCreateNodeLink(
    _: any,
    args: { input: { from: number; to: number; types?: string[]; title?: string; description?: string } },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    const graphSvc = graphService(context);
    try {
      const { from, to, types, title, description } = args.input;
      const primaryType = (types && types[0]) || ReactorLinkType.DIRECT;
      const link = await graphSvc.createLink(
        { id: from } as ReactorNode,
        primaryType,
        { id: to } as ReactorNode
      );
      // Apply the full type set / labels supplied by the caller.
      const updated = await graphSvc.updateLink({
        ...link,
        types: (types as ReactorLinkType[]) || link.types,
        title: title ?? link.title,
        description: description ?? link.description,
      });
      return {
        __typename: "ReactorCreateNodeLinkSuccess",
        link: updated,
        message: "Link created",
      };
    } catch (e) {
      return {
        __typename: "ReactorCreateNodeLinkFailure",
        link: { id: 0, source: args.input.from, target: args.input.to },
        error: (e as Error).message,
      };
    }
  }

  @mutation("ReactorUpdateNodeLink")
  async ReactorUpdateNodeLink(
    _: any,
    args: { input: { from: number; to: number; types?: string[]; title?: string; description?: string } },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    const graphSvc = graphService(context);
    try {
      const { from, to, types, title, description } = args.input;
      const primaryType = (types && types[0]) || ReactorLinkType.DIRECT;
      // Ensure the edge exists, then apply the incoming fields.
      const link = await graphSvc.createLink(
        { id: from } as ReactorNode,
        primaryType,
        { id: to } as ReactorNode
      );
      const updated = await graphSvc.updateLink({
        ...link,
        types: (types as ReactorLinkType[]) || link.types,
        title: title ?? link.title,
        description: description ?? link.description,
      });
      return {
        __typename: "ReactorNodeLinkUpdateSuccess",
        link: updated,
        message: "Link updated",
      };
    } catch (e) {
      return {
        __typename: "ReactorNodeLinkUpdateFailure",
        link: { id: 0, source: args.input.from, target: args.input.to },
        error: (e as Error).message,
      };
    }
  }

  @mutation("ReactorDeleteNodeLink")
  async ReactorDeleteNodeLink(
    _: any,
    args: { id: number },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    const graphSvc = graphService(context);
    try {
      await graphSvc.deleteLink({ id: args.id } as ReactorNodeLink);
      return { __typename: "ReactorDeleteNodeLinkSuccess", id: args.id, message: "Link deleted" };
    } catch (e) {
      return { __typename: "ReactorDeleteNodeLinkFailure", id: args.id, error: (e as Error).message };
    }
  }

  @mutation("ReactorSaveSystemGraph")
  async ReactorSaveSystemGraph(
    _: any,
    args: { graph: { title?: string; share?: boolean; nodes?: number[]; links?: { id: number; types?: string[]; title?: string; description?: string }[] } },
    context: Reactory.Server.IReactoryContext
  ): Promise<any> {
    const graphSvc = graphService(context);
    try {
      const links = args.graph?.links || [];
      for (const l of links) {
        await graphSvc.updateLink({
          id: l.id,
          types: l.types as ReactorLinkType[],
          title: l.title,
          description: l.description,
        } as ReactorNodeLink);
      }
      return {
        __typename: "ReactorSystemGraphSaveSuccess",
        success: true,
        message: `Saved graph with ${links.length} link update(s)`,
      };
    } catch (e) {
      return {
        __typename: "ReactorSysteGraphSaveFailure",
        id: 0,
        error: (e as Error).message,
      };
    }
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

  @mutation("ReactorUpdateNode")
  async ReactorUpdateNode(
    _: any,
    args: { id: number; data: any },
    context: Reactory.Server.IReactoryContext
  ): Promise<Partial<ReactorNode>> {
    const { id, data } = args;
    return graphService(context).updateNode(id, { data });
  }
}

export default ReactorSystemGraph;
