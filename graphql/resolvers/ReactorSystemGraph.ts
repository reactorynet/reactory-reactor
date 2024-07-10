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
  IReactorProjectPathSpec,
  ISystemGraphManager,
  PageReactorProjectResult,
  ReactorNodeAttributes,
} from "@reactory/server-modules/reactor/types/service.types";
import { ObjectId } from "mongodb";
import {
  PagingRequest,
  PagingResult,
} from "@reactory/server-core/database/types";
import {
  ReactorNode,
  ReactorNodeType,
  ReactorNodeCategory,
} from "@reactory/server-modules/reactor/types/model.types";

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
        id: new ObjectId(r.id),
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

  @property("ReactorProject", "fqn")
  getProjectFQN(project: IReactorProject) {
    return `${project.nameSpace}.${project.name}@${project.version || "1.0.0"}`;
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
    args: ReactorProjectFilterArgs,
    context: Reactory.Server.IReactoryContext
  ): Promise<PageReactorProjectResult> {
    const graphSvc = context.getService<ISystemGraphManager>(
      "reactor.SystemGraphManager@1.0.0"
    );
    return graphSvc.getProjects({});
  }

  @property("ReactorProjectPathSpec", "id")
  getProjectPathSpecId({ id, path, filter, type }: IReactorProjectPathSpec) {
    if (id && id instanceof ObjectId) return id;
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

  @mutation("ReactorSyncCatalogNode")
  async syncCatalogNode(
    _: any,
    args: { id: ObjectId },
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
}

export default ReactorSystemGraph;
