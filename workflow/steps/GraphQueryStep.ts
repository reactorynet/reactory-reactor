/**
 * GraphQueryStep — query and walk the Reactor system graph as a durable
 * workflow step.
 *
 * One step type with an `operation` discriminator (the `mongo_query` pattern):
 *
 *   operation: node      — resolve a single node by id (+ optional ancestry key)
 *   operation: nodes     — batch resolve nodes by ids
 *   operation: children  — expand one level of a node's children (lazy fs walk)
 *   operation: links     — list typed edges touching a node
 *   operation: subgraph  — bounded BFS neighbourhood from a root node
 *   operation: search    — find nodes by term (search-index backed when scoped)
 *   operation: path      — bounded shortest path between two nodes
 *
 * All operations delegate to `reactor.SystemGraphManager@1.0.0`, resolved from
 * the workflow's Reactory context INSIDE executeStep (the context is rebuilt on
 * durable resume — never capture services at construction).
 *
 * Outputs are trimmed to JSON-serializable essentials only. Returning raw
 * mongoose documents breaks durable instance persistence and makes the engine
 * re-run the step forever (see AgentConversationStep for the same rule).
 *
 * Example YAML:
 *   - id: findNodes
 *     type: graph_query
 *     config:
 *       operation: search
 *       term: "${input.term}"
 *       limit: 10
 *   - id: expand
 *     type: graph_query
 *     dependsOn: findNodes
 *     config:
 *       operation: subgraph
 *       rootId: "${steps.findNodes.outputs.firstNodeId}"
 *       depth: 2
 */

import { BaseYamlStep } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/base/BaseYamlStep';
import {
  StepExecutionContext,
  StepExecutionResult,
  ValidationResult,
} from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import {
  ISystemGraphManager,
} from '@reactory/server-modules/reactory-reactor/types/service.types';
import {
  ReactorNode,
  ReactorNodeLink,
} from '@reactory/server-modules/reactory-reactor/types/model.types';

const GRAPH_SERVICE_ID = 'reactor.SystemGraphManager@1.0.0';

const VALID_OPERATIONS = ['node', 'nodes', 'children', 'links', 'subgraph', 'search', 'path'] as const;
type GraphQueryOperation = (typeof VALID_OPERATIONS)[number];

const VALID_DIRECTIONS = ['in', 'out', 'both'];

/** Hard cap on nodes/links in step outputs — durable-serialization guard. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_DEPTH = 3;

export interface GraphQueryStepConfig {
  operation: GraphQueryOperation;
  /** node | children | links — the target node id (templatable). */
  id?: number | string;
  /** nodes — the target node ids. */
  ids?: (number | string)[];
  /** node | children — optional ancestry key ("rootId|...|nodeId"). */
  key?: string;
  /** search — the search term (templatable). */
  term?: string;
  /** search — project scoping for index-backed search. */
  projectName?: string;
  nameSpace?: string;
  /** subgraph — the traversal root (templatable). */
  rootId?: number | string;
  /** path — endpoints (templatable). */
  sourceId?: number | string;
  targetId?: number | string;
  /** subgraph — BFS depth (default 2, max 3). */
  depth?: number;
  /** links | subgraph — edge direction. */
  direction?: 'in' | 'out' | 'both';
  /** links | subgraph | path — restrict to these edge types. */
  types?: string[];
  /** subgraph — restrict result nodes to these types. */
  nodeTypes?: string[];
  /** children — file-name regex filter (folders always pass). */
  filter?: string;
  /** Result cap (default 100, hard cap 500). */
  limit?: number;
  enabled?: boolean;
}

/** Node essentials — everything a downstream step or agent prompt needs. */
interface TrimmedNode {
  id: number;
  name: string;
  type: string;
  key?: string;
  parentId?: number | null;
  path?: string;
  kind?: string;
}

interface TrimmedLink {
  id: number;
  source: number;
  target: number;
  types: string[];
  title?: string;
}

const trimNode = (node: Partial<ReactorNode>): TrimmedNode => ({
  id: node.id,
  name: node.name,
  type: String(node.type ?? 'UNKNOWN'),
  key: node.key,
  parentId: node.parentId ?? null,
  path: node.data?.relativePath,
  kind: node.data?.kind,
});

const trimLink = (link: Partial<ReactorNodeLink>): TrimmedLink => ({
  id: link.id,
  source: link.source,
  target: link.target,
  types: (link.types ?? (link.type ? [link.type] : [])).map(String),
  title: link.title,
});

export class GraphQueryStep extends BaseYamlStep {
  public readonly stepType = 'graph_query';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as GraphQueryStepConfig;

    if (!context.reactoryContext) {
      return {
        success: false,
        error: 'No Reactory context available — cannot query the system graph',
        outputs: {},
        metadata: {},
      };
    }

    const graphSvc = this.getGraphService(context);
    if (!graphSvc) {
      return {
        success: false,
        error: `Graph service (${GRAPH_SERVICE_ID}) is not available`,
        outputs: {},
        metadata: { operation: config.operation },
      };
    }

    // Optional templatable values: resolveTemplate leaves unresolved "${...}"
    // tokens intact by design — treat leftovers (or empty strings) as absent.
    const cleanOptional = (v: string | number | undefined): string | undefined => {
      if (v === undefined || v === null) return undefined;
      const resolved = this.resolveTemplate(String(v), context);
      if (typeof resolved === 'string' && (resolved.trim() === '' || resolved.includes('${'))) {
        return undefined;
      }
      return resolved;
    };
    const toId = (v: string | number | undefined): number | undefined => {
      const resolved = cleanOptional(v);
      if (resolved === undefined) return undefined;
      const n = Number(resolved);
      return Number.isFinite(n) ? n : undefined;
    };

    const operation = config.operation;
    const limit = Math.min(Math.max(config.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const direction = (config.direction as 'in' | 'out' | 'both') || 'both';

    try {
      switch (operation) {
        case 'node': {
          const id = toId(config.id);
          if (id === undefined) return this.missing(operation, 'id');
          let node: Partial<ReactorNode>;
          try {
            node = await graphSvc.getNode(id, cleanOptional(config.key));
          } catch {
            [node] = await graphSvc.getNodes([id]);
          }
          return this.result(operation, [node], []);
        }

        case 'nodes': {
          const ids = (config.ids ?? [])
            .map((v) => toId(v))
            .filter((v): v is number => v !== undefined)
            .slice(0, limit);
          if (!ids.length) return this.missing(operation, 'ids');
          const nodes = await graphSvc.getNodes(ids);
          return this.result(operation, nodes, []);
        }

        case 'children': {
          const id = toId(config.id);
          if (id === undefined) return this.missing(operation, 'id');
          const node = await graphSvc.getNode(id, cleanOptional(config.key));
          let children = await graphSvc.getChildren([node as ReactorNode]);
          const filter = cleanOptional(config.filter);
          if (filter) {
            try {
              const rx = new RegExp(filter);
              children = children.filter((c) => String(c.type) === 'FOLDER' || rx.test(c.name));
            } catch {
              context.logger.warn(`graph_query: invalid children filter regex '${filter}' — ignored`);
            }
          }
          const truncated = children.length > limit;
          return this.result(operation, children.slice(0, limit), [], truncated);
        }

        case 'links': {
          const id = toId(config.id);
          if (id === undefined) return this.missing(operation, 'id');
          const links = await graphSvc.getNodeLinks([id], {
            direction,
            types: config.types,
            limit,
          });
          const endpointIds = Array.from(new Set(links.flatMap((l) => [l.source, l.target])));
          const endpoints = await graphSvc.getNodes(endpointIds.slice(0, limit));
          return this.result(operation, endpoints, links);
        }

        case 'subgraph': {
          const rootId = toId(config.rootId);
          if (rootId === undefined) return this.missing(operation, 'rootId');
          const subgraph = await graphSvc.getSubgraph(rootId, {
            depth: Math.min(Math.max(config.depth ?? 2, 1), MAX_DEPTH),
            direction,
            linkTypes: config.types,
            nodeTypes: config.nodeTypes,
            limit,
            materialize: false,
          });
          return this.result(operation, subgraph.nodes, subgraph.links, subgraph.truncated);
        }

        case 'search': {
          const term = cleanOptional(config.term);
          if (!term) return this.missing(operation, 'term');
          const nodes = await graphSvc.searchNodes(term, {
            name: cleanOptional(config.projectName),
            nameSpace: cleanOptional(config.nameSpace),
            limit: Math.min(limit, 200),
          });
          const trimmed = nodes.map(trimNode);
          return {
            success: true,
            outputs: {
              operation,
              count: trimmed.length,
              truncated: false,
              nodes: trimmed,
              links: [],
              // Convenience for templating: ${steps.<id>.outputs.firstNodeId}
              nodeIds: trimmed.map((n) => n.id),
              firstNodeId: trimmed[0]?.id ?? null,
            },
            metadata: { operation, term },
          };
        }

        case 'path': {
          const sourceId = toId(config.sourceId);
          const targetId = toId(config.targetId);
          if (sourceId === undefined) return this.missing(operation, 'sourceId');
          if (targetId === undefined) return this.missing(operation, 'targetId');
          const path = await graphSvc.findPath(sourceId, targetId, {
            maxDepth: Math.min(Math.max(config.depth ?? 6, 1), 10),
            linkTypes: config.types,
          });
          const nodes = path.found ? await graphSvc.getNodes(path.nodeIds) : [];
          const outputs = {
            operation,
            found: path.found,
            count: nodes.length,
            truncated: false,
            nodes: nodes.map(trimNode),
            links: path.links.map(trimLink),
          };
          return { success: true, outputs, metadata: { operation, sourceId, targetId } };
        }

        default:
          return {
            success: false,
            error: `Unknown graph_query operation '${operation}'`,
            outputs: {},
            metadata: { operation },
          };
      }
    } catch (error) {
      const message = (error as Error)?.message ?? 'Unknown error';
      context.logger.error(`graph_query (${operation}) failed: ${message}`);
      return {
        success: false,
        error: `graph_query (${operation}) failed: ${message}`,
        outputs: {},
        metadata: { operation },
      };
    }
  }

  /** Standard success result with trimmed, serializable node/link arrays. */
  private result(
    operation: GraphQueryOperation,
    nodes: Partial<ReactorNode>[],
    links: Partial<ReactorNodeLink>[],
    truncated = false
  ): StepExecutionResult {
    const trimmedNodes = nodes.filter(Boolean).map(trimNode);
    const trimmedLinks = links.filter(Boolean).map(trimLink);
    return {
      success: true,
      outputs: {
        operation,
        count: trimmedNodes.length,
        truncated,
        nodes: trimmedNodes,
        links: trimmedLinks,
      },
      metadata: { operation },
    };
  }

  private missing(operation: GraphQueryOperation, field: string): StepExecutionResult {
    return {
      success: false,
      error: `graph_query (${operation}) requires '${field}'`,
      outputs: {},
      metadata: { operation },
    };
  }

  private getGraphService(context: StepExecutionContext): ISystemGraphManager | null {
    try {
      return context.reactoryContext?.getService<ISystemGraphManager>(GRAPH_SERVICE_ID) ?? null;
    } catch {
      return null;
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const operation = config.operation as GraphQueryOperation;

    if (!operation || !VALID_OPERATIONS.includes(operation)) {
      errors.push(`operation is required and must be one of: ${VALID_OPERATIONS.join(', ')}`);
      return { valid: false, errors };
    }

    const requireField = (field: string) => {
      const value = config[field];
      if (value === undefined || value === null || value === '') {
        errors.push(`${field} is required for operation '${operation}'`);
      }
    };

    switch (operation) {
      case 'node':
      case 'children':
      case 'links':
        requireField('id');
        break;
      case 'nodes':
        if (!Array.isArray(config.ids) || config.ids.length === 0) {
          errors.push(`ids is required for operation 'nodes' and must be a non-empty array`);
        }
        break;
      case 'search':
        requireField('term');
        break;
      case 'subgraph':
        requireField('rootId');
        break;
      case 'path':
        requireField('sourceId');
        requireField('targetId');
        break;
    }

    if (config.depth !== undefined && (typeof config.depth !== 'number' || config.depth < 1)) {
      errors.push('depth must be a positive number');
    }
    if (config.limit !== undefined && (typeof config.limit !== 'number' || config.limit < 1)) {
      errors.push('limit must be a positive number');
    }
    if (config.direction !== undefined && !VALID_DIRECTIONS.includes(config.direction)) {
      errors.push(`direction must be one of: ${VALID_DIRECTIONS.join(', ')}`);
    }
    if (config.types !== undefined && !Array.isArray(config.types)) {
      errors.push('types must be an array of link type names');
    }
    if (config.nodeTypes !== undefined && !Array.isArray(config.nodeTypes)) {
      errors.push('nodeTypes must be an array of node type names');
    }

    return { valid: errors.length === 0, errors };
  }
}

export default GraphQueryStep;
