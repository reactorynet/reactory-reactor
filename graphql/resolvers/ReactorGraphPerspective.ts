import {
  mutation,
  query,
  resolver,
  property,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import ApiError from "@reactory/server-core/exceptions";
import { PagingRequest } from "@reactory/server-core/database/types";
import {
  ReactorGraphPerspective,
  ReactorGraphPerspectiveFilters,
  ReactorGraphViewMode,
  ReactorGraphViewport,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import {
  ISystemGraphManager,
  ReactorProjectService,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorGraphPerspectiveModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphPerspective";

interface PerspectiveInput {
  id?: string;
  name: string;
  projectId?: string;
  rootNodeId?: number;
  nodePositions?: { nodeId: number; x: number; y: number; z?: number }[];
  expandedKeys?: string[];
  hiddenNodeIds?: number[];
  filters?: ReactorGraphPerspectiveFilters | null;
  layout?: string;
  viewMode?: ReactorGraphViewMode;
  depth?: number;
  viewport?: ReactorGraphViewport;
  share?: boolean;
  isDefault?: boolean;
}

interface ReactorGraphPerspectiveInputArgs {
  perspective: PerspectiveInput;
}

const VIEW_MODES: ReactorGraphViewMode[] = ["TWO_D", "THREE_D"];

/**
 * Module-level helpers — the @query/@mutation decorators copy UNBOUND function
 * references into the resolver map, so `this` inside a decorated method is
 * Apollo's field object, never the class instance. Helpers must live outside
 * the class.
 */
const ownerId = (context: Reactory.Server.IReactoryContext): string => {
  const owner = context?.user?._id?.toString?.() ?? `${context?.user?.id ?? ""}`;
  if (!owner) throw new ApiError("Not authorized", 401);
  return owner;
};

const clampDepth = (depth?: number | null): number | undefined => {
  if (depth === undefined || depth === null || !Number.isFinite(depth)) return undefined;
  return Math.min(Math.max(Math.round(depth), 1), 5);
};

const normalizeFilters = (
  filters?: ReactorGraphPerspectiveFilters | null
): ReactorGraphPerspectiveFilters | null | undefined => {
  if (filters === undefined) return undefined;
  if (filters === null) return null;
  return {
    nodeTypes: Array.isArray(filters.nodeTypes) ? filters.nodeTypes : null,
    linkTypes: Array.isArray(filters.linkTypes) ? filters.linkTypes : null,
  };
};

const normalizeViewMode = (viewMode?: ReactorGraphViewMode | null): ReactorGraphViewMode | undefined =>
  viewMode && VIEW_MODES.includes(viewMode) ? viewMode : undefined;

/**
 * Resolve the root node for a perspective when only the project is known —
 * the client route is project-scoped, the graph is node-scoped.
 */
const resolveRootNodeId = async (
  input: { rootNodeId?: number; projectId?: string },
  context: Reactory.Server.IReactoryContext
): Promise<number | undefined> => {
  if (input.rootNodeId !== undefined && input.rootNodeId !== null) return input.rootNodeId;
  if (!input.projectId) return undefined;
  try {
    const projectSvc = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    const graphSvc = context.getService<ISystemGraphManager>("reactor.SystemGraphManager@1.0.0");
    // getProject resolves by ObjectId string, FQN, name or repo path.
    const project = await projectSvc.getProject(input.projectId);
    if (!project) return undefined;
    const pNode = await graphSvc.getProjectNode(project);
    return pNode?.index !== undefined ? pNode.index : undefined;
  } catch {
    return undefined;
  }
};

/** Only one default per owner within a root/project scope. */
const clearOtherDefaults = async (
  owner: string,
  scope: { rootNodeId?: number | null; projectId?: string | null },
  keepId?: unknown
): Promise<void> => {
  const query: any = { owner, isDefault: true };
  if (scope.rootNodeId !== undefined && scope.rootNodeId !== null) query.rootNodeId = scope.rootNodeId;
  else if (scope.projectId) query.projectId = scope.projectId;
  if (keepId) query._id = { $ne: keepId };
  await ReactorGraphPerspectiveModel.updateMany(query, { $set: { isDefault: false } });
};

//@ts-ignore
@resolver
class ReactorGraphPerspectiveResolver {
  resolver: any;

  @property("ReactorGraphPerspective", "id")
  perspectiveId(perspective: any): string {
    return perspective?._id?.toString?.() ?? `${perspective?.id ?? ""}`;
  }

  @property("ReactorGraphPerspective", "isOwner")
  perspectiveIsOwner(perspective: any, _args: any, context: Reactory.Server.IReactoryContext): boolean {
    const owner = context?.user?._id?.toString?.() ?? `${context?.user?.id ?? ""}`;
    return Boolean(owner) && `${perspective?.owner}` === owner;
  }

  @property("ReactorGraphPerspective", "filters")
  perspectiveFilters(perspective: any): ReactorGraphPerspectiveFilters | null {
    const filters = perspective?.filters;
    if (!filters) return null;
    const nodeTypes = Array.isArray(filters.nodeTypes) && filters.nodeTypes.length > 0 ? filters.nodeTypes : null;
    const linkTypes = Array.isArray(filters.linkTypes) && filters.linkTypes.length > 0 ? filters.linkTypes : null;
    if (!nodeTypes && !linkTypes) return null;
    return { nodeTypes, linkTypes };
  }

  @query("ReactorGraphPerspectives")
  async ReactorGraphPerspectives(
    _: any,
    args: { projectId?: string; rootNodeId?: number; paging?: PagingRequest },
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorGraphPerspective[]> {
    const owner = ownerId(context);
    const paging = args.paging || { page: 1, pageSize: 100 };
    const page = Math.max(paging.page || 1, 1);
    const pageSize = Math.min(Math.max(paging.pageSize || 100, 1), 500);

    const query: any = { $or: [{ owner }, { share: true }] };
    if (args.projectId) query.projectId = args.projectId;
    if (args.rootNodeId !== undefined && args.rootNodeId !== null) query.rootNodeId = args.rootNodeId;

    return ReactorGraphPerspectiveModel.find(query)
      .sort({ isDefault: -1, updated: -1 })
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
    const name = (perspective.name ?? "").trim();
    if (!name) throw new ApiError("Perspective name is required", 400);
    const now = new Date();

    const rootNodeId = await resolveRootNodeId(perspective, context);
    const filters = normalizeFilters(perspective.filters);
    const viewMode = normalizeViewMode(perspective.viewMode);
    const depth = clampDepth(perspective.depth);

    if (perspective.id) {
      const existing = await ReactorGraphPerspectiveModel.findById(perspective.id);
      if (!existing) throw new ApiError(`Perspective ${perspective.id} not found`, 404);
      if (`${existing.owner}` !== owner) {
        throw new ApiError("Not authorized to update this perspective", 403);
      }
      // Renaming onto an existing name in the same scope must fail cleanly.
      const clash = await ReactorGraphPerspectiveModel.findOne({
        owner,
        name,
        projectId: perspective.projectId ?? existing.projectId ?? null,
        _id: { $ne: existing._id },
      }).lean();
      if (clash) throw new ApiError(`A perspective named "${name}" already exists`, 409);

      existing.set({
        name,
        projectId: perspective.projectId ?? existing.projectId,
        rootNodeId: rootNodeId ?? existing.rootNodeId,
        nodePositions: perspective.nodePositions ?? existing.nodePositions,
        expandedKeys: perspective.expandedKeys ?? existing.expandedKeys,
        hiddenNodeIds: perspective.hiddenNodeIds ?? existing.hiddenNodeIds,
        filters: filters === undefined ? existing.filters : filters,
        layout: perspective.layout ?? existing.layout,
        viewMode: viewMode ?? existing.viewMode,
        depth: depth ?? existing.depth,
        viewport: perspective.viewport ?? existing.viewport,
        share: perspective.share ?? existing.share,
        isDefault: perspective.isDefault ?? existing.isDefault,
        updated: now,
      });
      await existing.save();
      if (existing.isDefault) {
        await clearOtherDefaults(owner, { rootNodeId: existing.rootNodeId, projectId: existing.projectId }, existing._id);
      }
      return existing.toObject() as unknown as ReactorGraphPerspective;
    }

    const scopeProjectId = perspective.projectId ?? null;
    const created = await ReactorGraphPerspectiveModel.findOneAndUpdate(
      { owner, name, projectId: scopeProjectId },
      {
        $set: {
          rootNodeId: rootNodeId ?? null,
          nodePositions: perspective.nodePositions ?? [],
          expandedKeys: perspective.expandedKeys ?? [],
          hiddenNodeIds: perspective.hiddenNodeIds ?? [],
          filters: filters ?? null,
          layout: perspective.layout ?? null,
          viewMode: viewMode ?? null,
          depth: depth ?? null,
          viewport: perspective.viewport,
          share: perspective.share ?? false,
          isDefault: perspective.isDefault ?? false,
          updated: now,
        },
        $setOnInsert: { owner, name, projectId: scopeProjectId, created: now },
      },
      { upsert: true, new: true }
    ).lean();

    if (created && (created as any).isDefault) {
      await clearOtherDefaults(owner, { rootNodeId: rootNodeId ?? null, projectId: scopeProjectId }, (created as any)._id);
    }

    return created as unknown as ReactorGraphPerspective;
  }

  @mutation("ReactorDuplicateGraphPerspective")
  async ReactorDuplicateGraphPerspective(
    _: any,
    args: { id: string; name: string },
    context: Reactory.Server.IReactoryContext
  ): Promise<ReactorGraphPerspective> {
    const owner = ownerId(context);
    const name = (args.name ?? "").trim();
    if (!name) throw new ApiError("Perspective name is required", 400);
    const source = (await ReactorGraphPerspectiveModel.findById(args.id).lean()) as any;
    if (!source) throw new ApiError(`Perspective ${args.id} not found`, 404);
    if (`${source.owner}` !== owner && source.share !== true) {
      throw new ApiError("Not authorized to duplicate this perspective", 403);
    }
    const clash = await ReactorGraphPerspectiveModel.findOne({
      owner,
      name,
      projectId: source.projectId ?? null,
    }).lean();
    if (clash) throw new ApiError(`A perspective named "${name}" already exists`, 409);

    const now = new Date();
    const copy = await ReactorGraphPerspectiveModel.create({
      name,
      owner,
      projectId: source.projectId ?? null,
      rootNodeId: source.rootNodeId ?? null,
      nodePositions: source.nodePositions ?? [],
      expandedKeys: source.expandedKeys ?? [],
      hiddenNodeIds: source.hiddenNodeIds ?? [],
      filters: source.filters ?? null,
      layout: source.layout ?? null,
      viewMode: source.viewMode ?? null,
      depth: source.depth ?? null,
      viewport: source.viewport,
      share: false,
      isDefault: false,
      created: now,
      updated: now,
    });
    return copy.toObject() as unknown as ReactorGraphPerspective;
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
