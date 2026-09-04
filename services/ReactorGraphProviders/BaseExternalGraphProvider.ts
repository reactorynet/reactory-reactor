import { randomUUID } from "crypto";
import Reactory from "@reactorynet/reactory-core";
import {
  IReactorProject,
  IReactorProjectFileSpec,
  IProjectProcessor,
  GraphProcessMetrics,
  ProcessOptions,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import { PagingRequest } from "@reactory/server-core/database/types";
import { canonicalProjectId, projectFqn } from "../graph/GraphIdentity";
import { ReactorNodeModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphNode";
import BaseGraphProvider, { isMongoAvailable } from "./BaseGraphProvider";

/**
 * One bounded unit of discovery from an external source - typically one page
 * of an API response. Nodes carry deterministic ids from
 * `GraphIdentity.sourceLogicalKey`; edges may only reference nodes the
 * provider created (or will create) in this run (invariants I4/P6 - emit a
 * stub node for out-of-scope targets rather than a dangling edge).
 */
export interface ExternalEntityBatch {
  nodes: Partial<ReactorNode>[];
  edges?: ReactorNodeLink[];
  searchables?: Reactory.Models.ISearchable[];
}

/**
 * BaseExternalGraphProvider is the template for graph providers over sources
 * that are **not folders on disk**: Jira sites, database systems, and future
 * registered sources.
 *
 * Differences from the filesystem pipeline (BaseProjectProcessor.process):
 *
 *  - **Registered, not detected** (invariant P3): `supportsProject` checks the
 *    project's `source.scheme` - never the filesystem or the network.
 *  - **Batched persistence**: `discoverEntities` is an async generator; each
 *    batch is persisted as it arrives so memory stays bounded on large scopes.
 *  - **Incremental by contentHash**: providers stamp `node.contentHash` from a
 *    source version (an `updated` timestamp, a DDL hash). Unchanged entities
 *    skip re-persist + re-index; their descendants/edges are touched with the
 *    current runId so GC preserves them (session-08 semantics).
 *  - **No GC on a partial snapshot**: if `discoverEntities` throws mid-run, GC
 *    is skipped - a half-enumerated scope must never delete the other half.
 */
export abstract class BaseExternalGraphProvider
  extends BaseGraphProvider
  implements IProjectProcessor
{
  // ---- External-source contract ---------------------------------------------

  /** The identity scheme this provider owns ('jira', 'db', ...). */
  abstract sourceScheme(): string;

  /**
   * Streams the source snapshot in bounded batches. Implementations page
   * through the remote API / introspection queries and yield as they go.
   * Throwing aborts the run: persisted batches stay, GC is skipped.
   */
  abstract discoverEntities(
    project: Partial<IReactorProject>,
    options: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch>;

  /** The stable source instance key (site host, connectionId). */
  sourceKeyFor(project: Partial<IReactorProject>): string {
    return project?.source?.sourceKey || "";
  }

  /**
   * Node types loaded for incremental comparison. `null` (default) loads every
   * previously persisted node of the project - external entity types vary per
   * provider.
   */
  protected trackedNodeTypes(): ReactorNodeType[] | null {
    return null;
  }

  // ---- IProjectProcessor conformance (registered, not detected) ---------------

  supportsProject(project: Partial<IReactorProject>): boolean {
    return project?.source?.scheme === this.sourceScheme();
  }

  protected rootSource(project: Partial<IReactorProject>): string | undefined {
    if (project?.source?.scheme) {
      return `${project.source.scheme}:${project.source.sourceKey || ""}`;
    }
    return project?.repoPath;
  }

  getFileSpecs(_project: Partial<IReactorProject>): Partial<IReactorProjectFileSpec>[] {
    return [];
  }

  async setFileSpecs(
    project: Partial<IReactorProject>,
    _specs: Partial<IReactorProjectFileSpec>[]
  ): Promise<Partial<IReactorProject>> {
    return project;
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

  // ---- Lazy tree expansion ----------------------------------------------------

  /**
   * Default child expansion for external nodes: the **persisted** graph. The
   * snapshot pipeline persists every entity, so the persisted children are the
   * source of truth; concrete providers may override for live remote browsing
   * (with caching), guarded so missing credentials degrade to persisted data.
   */
  async getChildrenForNode(
    node: Partial<ReactorNode>,
    _treeKey: string,
    filter: string,
    paging: PagingRequest
  ): Promise<ReactorNode[]> {
    if (node?.data?.noExpand === true) return [];
    if (node?.id === undefined || node?.id === null) return [];
    if (!isMongoAvailable(ReactorNodeModel.find)) return [];
    try {
      const children = ((await ReactorNodeModel.find({ parentId: node.id })
        .lean()) as unknown as ReactorNode[]) || [];
      let result = children;
      if (filter) {
        try {
          const rx = new RegExp(filter, "i");
          result = children.filter((c) => !c.name || rx.test(c.name));
        } catch {
          // invalid filter regex - return unfiltered
        }
      }
      result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      const paged = this.applyPaging(result, paging);
      await Promise.all(
        paged.map((c) => this.context.setValue(`REACTOR_NODE_${c.id}`, c))
      );
      return paged;
    } catch (err) {
      this.context.warn(
        `getChildrenForNode failed for external node ${node?.id}: ${(err as Error).message}`
      );
      return [];
    }
  }

  // ---- Snapshot pipeline -------------------------------------------------------

  async process(
    project: Partial<IReactorProject>,
    options?: ProcessOptions
  ): Promise<Partial<IReactorProject>> {
    const startTime = Date.now();
    let errorCount = 0;
    const next = { ...project };
    const projectId = canonicalProjectId(next);
    if (projectId) {
      next.id = projectId as any;
    }

    const runId = options?.runId || randomUUID();
    const indexedAt = new Date();
    const { partnerId, organizationId } = this.resolveTenancy(next);
    const meta = {
      projectId: next.id,
      projectFqn: projectFqn(next),
      runId,
      indexedAt,
      partnerId,
      organizationId,
    };

    const root = (await this.getProjectNode(next)) as Partial<ReactorNode>;
    const bustIds = new Set<number>();
    const seenNodeIds = new Set<number>();
    const seenEdgeIds = new Set<number>();
    let nodesUpserted = 0;
    let edgesUpserted = 0;
    let entitiesDiscovered = 0;
    let entitiesSkipped = 0;
    let persistOk = true;
    let discoveryError: Error | null = null;

    // Persist the root first so a failed discovery still leaves a usable root.
    const rootResult = await this.persistGraph([root], [], meta);
    if (!rootResult.ok) {
      persistOk = false;
      errorCount++;
    }
    nodesUpserted += 1;
    if (root.id !== undefined && root.id !== null) bustIds.add(root.id as number);

    const prevById = await this.loadPreviousNodes(next, this.trackedNodeTypes());

    try {
      for await (const batch of this.discoverEntities(next, options || {})) {
        if (!batch) continue;

        const changed: Partial<ReactorNode>[] = [];
        const skippedIds = new Set<number>();

        for (const n of batch.nodes || []) {
          if (!n || n.id === undefined || n.id === null) continue;
          entitiesDiscovered++;
          bustIds.add(n.id as number);
          const prev = prevById.get(n.id as number);
          const unchanged =
            !options?.forceFull &&
            !!prev &&
            !!prev.contentHash &&
            !!n.contentHash &&
            prev.contentHash === n.contentHash;
          if (unchanged) {
            entitiesSkipped++;
            skippedIds.add(n.id as number);
            seenNodeIds.add(n.id as number);
          } else {
            changed.push(n);
          }
        }

        // Preserve descendants + touching edges of unchanged entities across GC.
        if (skippedIds.size > 0 && next.id) {
          for (const id of skippedIds) {
            const childIds = await this.loadDescendantNodeIds(id, String(next.id));
            childIds.forEach((c) => seenNodeIds.add(c));
            const edgeIds = await this.loadEdgeIdsTouching(
              [id, ...childIds],
              String(next.id)
            );
            edgeIds.forEach((e) => seenEdgeIds.add(e));
          }
        }

        const edges = (batch.edges || []).filter(
          (e) => e && e.id !== undefined && e.id !== null
        );
        for (const e of edges) {
          if (!e.projectId && meta.projectId) e.projectId = meta.projectId as any;
          if (!e.partnerId && partnerId) e.partnerId = partnerId;
          if (!e.organizationId && organizationId) e.organizationId = organizationId;
        }

        if (changed.length > 0 || edges.length > 0) {
          const res = await this.persistGraph(changed, edges, meta);
          if (!res.ok) {
            persistOk = false;
            errorCount++;
          }
          nodesUpserted += changed.length;
          edgesUpserted += edges.length;
        }

        // Unchanged entities keep their existing search documents.
        const searchables = (batch.searchables || []).filter((s) => {
          const sid = (s as any)?.nodeId;
          return typeof sid !== "number" || !skippedIds.has(sid);
        });
        if (searchables.length > 0) {
          await this.indexSearchables(next, searchables);
        }
      }
    } catch (err) {
      discoveryError = err as Error;
      errorCount++;
      this.context.error(
        `discoverEntities failed for ${projectFqn(next)} (runId=${runId}): ${discoveryError.message}\n${discoveryError.stack || ""}`
      );
    }

    // Re-stamp skipped unchanged nodes & edges so GC preserves them.
    if (seenNodeIds.size > 0) {
      await this.touchNodes(Array.from(seenNodeIds), { runId, indexedAt });
    }
    if (seenEdgeIds.size > 0) {
      await this.touchEdges(Array.from(seenEdgeIds), { runId, indexedAt });
    }

    await this.bustNodeCache(bustIds);

    // GC only after a COMPLETE snapshot that persisted cleanly. A partial
    // enumeration (discovery error) must never delete the un-enumerated rest.
    let nodesGcDeleted = 0;
    let edgesGcDeleted = 0;
    const canGc =
      !options?.skipGc && !!meta.projectId && persistOk && !discoveryError;
    if (canGc) {
      const gc = await this.gcStale(String(meta.projectId), runId);
      nodesGcDeleted = gc.nodesGcDeleted;
      edgesGcDeleted = gc.edgesGcDeleted;
      if (gc.error) errorCount++;
    } else if (!options?.skipGc && discoveryError) {
      this.context.warn(
        `GC skipped for ${projectFqn(next)}: discovery incomplete (${discoveryError.message})`
      );
    } else if (!options?.skipGc && meta.projectId && !persistOk) {
      this.context.error(`GC skipped because persistGraph failed for ${projectFqn(next)}`);
    } else if (!options?.skipGc && !meta.projectId) {
      this.context.warn(
        `GC skipped because projectId is missing for project ${next.name || next.fqn}`
      );
    }

    const durationMs = Date.now() - startTime;
    const metrics: GraphProcessMetrics = {
      projectId: String(next.id || ""),
      projectFqn: projectFqn(next),
      runId,
      filesDiscovered: entitiesDiscovered,
      filesAnalysed: entitiesDiscovered - entitiesSkipped,
      filesSkipped: entitiesSkipped,
      foldersCreated: 0,
      nodesUpserted,
      edgesUpserted,
      nodesGcDeleted,
      edgesGcDeleted,
      durationMs,
      errors: errorCount,
      byLanguage: {},
    };
    this.lastMetrics = metrics;

    try {
      this.context.info("graph.process.complete", metrics as any);
    } catch {
      this.context.info(`graph.process.complete: ${JSON.stringify(metrics)}`);
    }

    this.context.info(
      `process ${next.name} [${this.sourceScheme()}]: discovered=${entitiesDiscovered} skipped=${entitiesSkipped} edges=${edgesUpserted}${discoveryError ? " INCOMPLETE" : ""} (runId=${runId}, duration=${durationMs}ms)`
    );
    return next;
  }
}

export default BaseExternalGraphProvider;
