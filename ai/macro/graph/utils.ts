import { ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ISystemGraphManager } from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorNode,
  ReactorNodeLink,
} from "@reactory/server-modules/reactory-reactor/types/model.types";

export const SYSTEM_GRAPH_SERVICE_ID = "reactor.SystemGraphManager@1.0.0";

/** Node essentials — token-safe shape shared by every graph macro result. */
export interface TrimmedGraphNode {
  id: number;
  name: string;
  type: string;
  key?: string;
  parentId?: number | null;
  path?: string;
  kind?: string;
  language?: string;
  symlinkTarget?: string;
}

/** Edge essentials — token-safe shape shared by every graph macro result. */
export interface TrimmedGraphLink {
  id: number;
  source: number;
  target: number;
  types: string[];
  title?: string;
}

export const trimNode = (node: Partial<ReactorNode>): TrimmedGraphNode => ({
  id: node.id,
  name: node.name,
  type: String(node.type ?? "UNKNOWN"),
  key: node.key,
  parentId: node.parentId ?? null,
  path: node.data?.relativePath,
  kind: node.data?.kind,
  language: node.data?.language,
  symlinkTarget: node.data?.symlink?.relativeTarget ?? node.data?.symlink?.target,
});

export const trimLink = (link: Partial<ReactorNodeLink>): TrimmedGraphLink => ({
  id: link.id,
  source: link.source,
  target: link.target,
  types: (link.types ?? (link.type ? [link.type] : [])).map(String),
  title: link.title,
});

/**
 * Renders a subgraph as a compact adjacency list — far fewer tokens than the
 * equivalent JSON and easy for a model to follow.
 */
export const adjacencyMarkdown = (
  nodes: TrimmedGraphNode[],
  links: TrimmedGraphLink[]
): string => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (id: number) => {
    const n = byId.get(id);
    return n ? `${n.name} (${n.type}, ${n.id})` : `#${id}`;
  };
  const lines: string[] = [];
  for (const link of links) {
    lines.push(`- ${label(link.source)} -${link.types.join("+")}-> ${label(link.target)}`);
  }
  const linked = new Set(links.flatMap((l) => [l.source, l.target]));
  const isolated = nodes.filter((n) => !linked.has(n.id));
  if (isolated.length) {
    lines.push("", "Unlinked nodes:");
    isolated.forEach((n) => lines.push(`- ${label(n.id)}`));
  }
  return lines.join("\n");
};

/** Resolves the graph façade, or null (macros return errors, never throw). */
export const getGraphService = (chatState: ChatState): ISystemGraphManager | null => {
  try {
    return chatState.context?.getService<ISystemGraphManager>(SYSTEM_GRAPH_SERVICE_ID) ?? null;
  } catch {
    return null;
  }
};

/** Standard service-unavailable failure result for graph macros. */
export const serviceUnavailable = (tool: string, params: unknown) => ({
  success: false,
  error: "SystemGraphManager service is not available",
  tool,
  params,
  instructions: `## ${tool} — Service Unavailable\n\nThe reactor.SystemGraphManager service is not registered.\n\n### Recovery Options:\n- Verify the reactor module is loaded\n- Use \`svc\` with action="list" to check available services`,
});
