import {
  mutation,
  query,
  resolver,
  property,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import ApiError from "@reactory/server-core/exceptions";
import { PagingRequest } from "@reactory/server-core/database/types";
import { ReactorGraphPerspective } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { ReactorGraphPerspectiveModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphPerspective";

interface ReactorGraphPerspectiveInputArgs {
  perspective: {
    id?: string;
    name: string;
    projectId?: string;
    rootNodeId?: number;
    nodePositions?: { nodeId: number; x: number; y: number; z?: number }[];
    expandedKeys?: string[];
    viewport?: ReactorGraphPerspective["viewport"];
    share?: boolean;
  };
}

/**
 * Module-level helper — the @query/@mutation decorators copy UNBOUND function
 * references into the resolver map, so `this` inside a decorated method is
 * Apollo's field object, never the class instance. Helpers must live outside
 * the class.
 */
const ownerId = (context: Reactory.Server.IReactoryContext): string => {
  const owner = context?.user?._id?.toString?.() ?? `${context?.user?.id ?? ""}`;
  if (!owner) throw new ApiError("Not authorized", 401);
  return owner;
};

//@ts-ignore
@resolver
class ReactorGraphPerspectiveResolver {
  resolver: any;

  @property("ReactorGraphPerspective", "id")
  perspectiveId(perspective: any): string {
    return perspective?._id?.toString?.() ?? `${perspective?.id ?? ""}`;
  }

  @query("ReactorGraphPerspectives")
  async ReactorGraphPerspectives(
    _: any,
    args: { projectId?: string; paging?: PagingRequest },
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorGraphPerspective[]> {
    const owner = ownerId(context);
    const paging = args.paging || { page: 1, pageSize: 100 };
    const page = Math.max(paging.page || 1, 1);
    const pageSize = Math.min(Math.max(paging.pageSize || 100, 1), 500);

    const query: any = { $or: [{ owner }, { share: true }] };
    if (args.projectId) query.projectId = args.projectId;

    return ReactorGraphPerspectiveModel.find(query)
      .sort({ updated: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean() as unknown as ReactorGraphPerspective[];
  }

  @query("ReactorGraphPerspective")
  async ReactorGraphPerspective(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorGraphPerspective | null> {
    const owner = ownerId(context);
    const perspective = (await ReactorGraphPerspectiveModel.findById(
      args.id
    ).lean()) as unknown as ReactorGraphPerspective | null;
    if (!perspective) return null;
    if (`${perspective.owner}` !== owner && perspective.share !== true) {
      throw new ApiError("Not authorized to view this perspective", 403);
    }
    return perspective;
  }

  @mutation("ReactorSaveGraphPerspective")
  async ReactorSaveGraphPerspective(
    _: any,
    args: ReactorGraphPerspectiveInputArgs,
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorGraphPerspective> {
    const owner = ownerId(context);
    const { perspective } = args;
    const now = new Date();

    let rootNodeId = perspective.rootNodeId;
    if ((rootNodeId === undefined || rootNodeId === null) && perspective.projectId) {
      try {
        const projectSvc = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
        const graphSvc = context.getService<ISystemGraphManager>("reactor.SystemGraphManager@1.0.0");
        const project = await projectSvc.getProjectById(perspective.projectId);
        if (project) {
          const pNode = await graphSvc.getProjectNode(project);
          if (pNode && pNode.index !== undefined) {
            rootNodeId = pNode.index;
          }
        }
      } catch {
        // ignore
      }
    }

    if (perspective.id) {
      const existing = await ReactorGraphPerspectiveModel.findById(perspective.id);
      if (!existing) throw new ApiError(`Perspective ${perspective.id} not found`, 404);
      if (`${existing.owner}` !== owner) {
        throw new ApiError("Not authorized to update this perspective", 403);
      }
      existing.set({
        name: perspective.name,
        projectId: perspective.projectId,
        rootNodeId: rootNodeId ?? existing.rootNodeId,
        nodePositions: perspective.nodePositions ?? existing.nodePositions,
        expandedKeys: perspective.expandedKeys ?? existing.expandedKeys,
        viewport: perspective.viewport ?? existing.viewport,
        share: perspective.share ?? existing.share,
        updated: now,
      });
      await existing.save();
      return existing.toObject() as unknown as ReactorGraphPerspective;
    }

    const created = await ReactorGraphPerspectiveModel.findOneAndUpdate(
      { owner, name: perspective.name, projectId: perspective.projectId ?? null },
      {
        $set: {
          rootNodeId: rootNodeId ?? null,
          nodePositions: perspective.nodePositions ?? [],
          expandedKeys: perspective.expandedKeys ?? [],
          viewport: perspective.viewport,
          share: perspective.share ?? false,
          updated: now,
        },
        $setOnInsert: { owner, name: perspective.name, projectId: perspective.projectId ?? null, created: now },
      },
      { upsert: true, new: true }
    ).lean();

    return created as unknown as ReactorGraphPerspective;
  }

  @mutation("ReactorDeleteGraphPerspective")
  async ReactorDeleteGraphPerspective(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<boolean> {
    const owner = ownerId(context);
    const existing = await ReactorGraphPerspectiveModel.findById(args.id);
    if (!existing) return false;
    if (`${existing.owner}` !== owner) {
      throw new ApiError("Not authorized to delete this perspective", 403);
    }
    await ReactorGraphPerspectiveModel.deleteOne({ _id: existing._id });
    return true;
  }
}

export default ReactorGraphPerspectiveResolver;
