import { service } from "@reactory/server-core/application/decorators";
import {
  IReactorProject,
  KnownReactorProjectTypes,
  ProcessOptions,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorNode,
  ReactorNodeLink,
  ReactorNodeType,
  ReactorLinkType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import type {
  JiraBoard,
  JiraIssue,
  JiraSprint,
} from "@reactory/server-modules/reactory-atlassian/types";
import {
  linkId,
  nodeId,
  projectLogicalKey,
  sourceLogicalKey,
} from "../../graph/GraphIdentity";
import BaseExternalGraphProvider, {
  ExternalEntityBatch,
} from "../BaseExternalGraphProvider";

/** The subset of atlassian.JiraReaderService@1.0.0 this provider consumes. */
export interface IJiraReader {
  /**
   * Pins the reader to a source: host = the registered site, credentials from
   * the partner setting when given (per-partner fallback, else env). Optional —
   * older readers without it stay env-configured.
   */
  configureSource?(opts?: { settingKey?: string; host?: string } | null): void;
  searchIssues(
    jql: string,
    startAt?: number,
    maxResults?: number,
    opts?: { extraFields?: string[]; nextPageToken?: string }
  ): Promise<{ issues: JiraIssue[]; total: number; nextPageToken?: string; isLast?: boolean }>;
  getBoards(projectKeyOrName?: string): Promise<JiraBoard[]>;
  getSprints(boardId: number, state?: string): Promise<JiraSprint[]>;
}

export interface JiraSourceOptions {
  /** Required scope — the Jira project keys to snapshot. Never a whole-site sync. */
  projectKeys: string[];
  /** Extra JQL ANDed into every project query (e.g. "updated >= -90d"). */
  jql?: string;
  /** Snapshot agile boards + sprints (default true). */
  includeBoards?: boolean;
  /** Include comment text in ticket searchables (default false). */
  includeComments?: boolean;
  /** Hard bound per project; truncation is logged (invariant P4). Default 5000. */
  maxIssuesPerProject?: number;
  /** Issue page size (max 100). */
  pageSize?: number;
  /** Sprint custom-field id to request explicitly (default customfield_10020). */
  sprintFieldId?: string;
}

const SCHEME = "jira";
const READER_FQN = "atlassian.JiraReaderService@1.0.0";
const DEFAULT_MAX_ISSUES = 5000;
const DEFAULT_SPRINT_FIELD = "customfield_10020";

/**
 * JiraGraphProvider — read-only snapshot of a Jira site scope into the system
 * graph (Providers Session 03).
 *
 * Tree: root (SYSTEM) → Jira project (CONTAINER) → tickets (TICKET);
 *       Jira project → boards (BOARD) → sprints (SPRINT).
 * Edges: issue links (BLOCKS / DUPLICATES / RELATES), PART_OF (ticket →
 *        sprint / board / parent ticket), ASSIGNED_TO (ticket → PERSON).
 *
 * Identity (invariant P1, all computable from a reference alone):
 *   project  jira:<site>/<KEY>
 *   ticket   jira:<site>/<KEY>#<KEY-123>
 *   board    jira:<site>/<KEY>/boards#<boardId>
 *   sprint   jira:<site>/<KEY>/boards/<boardId>#sprint-<id>
 *   person   jira:<site>#person:<accountId>
 *
 * Out-of-scope issue-link targets get stub TICKET nodes (`data.stub: true`,
 * invariant P6) so no edge dangles; stubs are excluded from search indexing
 * and are overwritten by the full node if the ticket is enumerated later
 * (deterministic ids make the order irrelevant, guarded so a late stub never
 * overwrites an already-emitted full node).
 *
 * Incremental: contentHash = updated|status|sprints — unchanged tickets skip
 * re-persist and re-index (BaseExternalGraphProvider semantics).
 *
 * Credentials: resolved by atlassian.JiraReaderService at runtime — nothing
 * secret is ever stored on the project or its nodes (invariant P2). Read-only:
 * this provider never writes back to Jira.
 */
@service({
  name: "JiraGraphProvider",
  nameSpace: "reactor",
  version: "1.0.0",
  description:
    "Graphs a Jira site scope (projects, boards, sprints, tickets, issue links) into the system graph. Read-only.",
  id: "reactor.JiraGraphProvider@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
export class JiraGraphProvider extends BaseExternalGraphProvider {
  nameSpace = "reactor";
  name = "JiraGraphProvider";
  version = "1.0.0";

  sourceScheme(): string {
    return SCHEME;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return this.supportsProject(project) ? (["rest"] as KnownReactorProjectTypes[]) : [];
  }

  /** Resolved lazily so a deployment without reactory-atlassian still boots. */
  protected reader(): IJiraReader | null {
    try {
      return this.context.getService<IJiraReader>(READER_FQN) || null;
    } catch {
      return null;
    }
  }

  private optionsOf(project: Partial<IReactorProject>): JiraSourceOptions {
    return (project?.source?.options || {}) as JiraSourceOptions;
  }

  private siteOf(project: Partial<IReactorProject>): string {
    return this.sourceKeyFor(project);
  }

  browseUrl(site: string, issueKey: string): string {
    return `https://${site}/browse/${issueKey}`;
  }

  // ---- node builders ---------------------------------------------------------

  private baseNode(
    project: Partial<IReactorProject>,
    id: number,
    name: string,
    type: ReactorNodeType,
    parentId: number,
    parentKey: string,
    data: Record<string, any>
  ): Partial<ReactorNode> {
    return {
      id,
      index: id,
      name,
      key: `${parentKey}|${id}`,
      type,
      parentId,
      providerId: this.fqn(),
      nameSpace: project.nameSpace,
      version: project.version,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data,
    };
  }

  private ticketNode(
    project: Partial<IReactorProject>,
    site: string,
    projectKey: string,
    issue: JiraIssue,
    containerId: number,
    rootId: number
  ): Partial<ReactorNode> {
    const id = nodeId(sourceLogicalKey(SCHEME, site, projectKey, issue.key));
    const sprintIds = (issue.sprints || []).map((s) => s.id).sort();
    const node = this.baseNode(
      project,
      id,
      issue.key,
      ReactorNodeType.TICKET,
      containerId,
      `${rootId}|${containerId}`,
      {
        kind: "ticket",
        searchId: sourceLogicalKey(SCHEME, site, projectKey, issue.key),
        ticketKey: issue.key,
        projectKey,
        issueType: issue.issueType?.name,
        status: issue.status?.name,
        statusCategory: issue.status?.statusCategory?.key,
        priority: issue.priority?.name,
        labels: issue.labels || [],
        summary: issue.summary,
        url: this.browseUrl(site, issue.key),
        created: issue.created,
        updated: issue.updated,
        sprintIds,
      }
    );
    node.description = issue.summary;
    node.contentHash = `${issue.updated}|${issue.status?.name || ""}|${sprintIds.join(",")}`;
    return node;
  }

  private stubTicketNode(
    project: Partial<IReactorProject>,
    site: string,
    linkedKey: string,
    rootId: number,
    summary?: string
  ): Partial<ReactorNode> {
    const projectKey = linkedKey.split("-")[0];
    const id = nodeId(sourceLogicalKey(SCHEME, site, projectKey, linkedKey));
    return this.baseNode(
      project,
      id,
      linkedKey,
      ReactorNodeType.TICKET,
      rootId,
      `${rootId}`,
      {
        kind: "ticket",
        stub: true,
        ticketKey: linkedKey,
        projectKey,
        summary,
        url: this.browseUrl(site, linkedKey),
        noExpand: true,
      }
    );
  }

  // ---- issue-link mapping ------------------------------------------------------

  private linkTypeFor(typeName: string): ReactorLinkType {
    const t = (typeName || "").toLowerCase();
    if (t.includes("block")) return ReactorLinkType.BLOCKS;
    if (t.includes("duplicate") || t.includes("clone")) return ReactorLinkType.DUPLICATES;
    return ReactorLinkType.RELATES;
  }

  // ---- discovery -----------------------------------------------------------------

  async *discoverEntities(
    project: Partial<IReactorProject>,
    _options: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch> {
    const opts = this.optionsOf(project);
    const projectKeys = (opts.projectKeys || []).map((k) => String(k).toUpperCase());
    if (projectKeys.length === 0) {
      throw new Error(
        "jira source requires source.options.projectKeys — whole-site syncs are not supported"
      );
    }
    const reader = this.reader();
    if (!reader) {
      throw new Error(`${READER_FQN} is not available — is the reactory-atlassian module enabled?`);
    }

    const site = this.siteOf(project);
    // Pin the reader to this source's site + credentials (per-partner settingKey
    // with env fallback). An unresolvable settingKey throws here — the template
    // records the error and skips GC (fail-safe).
    if (typeof reader.configureSource === "function") {
      reader.configureSource({ settingKey: project.source?.settingKey, host: site });
    }
    const rootId = nodeId(projectLogicalKey(project));
    const maxIssues = opts.maxIssuesPerProject ?? DEFAULT_MAX_ISSUES;
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
    const sprintField = opts.sprintFieldId || DEFAULT_SPRINT_FIELD;
    const extraFields = ["issuelinks", "parent", sprintField];

    /** Full (non-stub) ticket ids emitted so far — a late stub must never overwrite one. */
    const fullTicketIds = new Set<number>();
    /** Person node ids emitted so far (dedupe across batches). */
    const personIds = new Set<number>();
    /** Sprint node ids already emitted (stub via issue field, or full via board phase). */
    const sprintIdsEmitted = new Set<number>();

    for (const projectKey of projectKeys) {
      const containerId = nodeId(sourceLogicalKey(SCHEME, site, projectKey));
      const containerKey = `${rootId}|${containerId}`;
      yield {
        nodes: [
          this.baseNode(
            project,
            containerId,
            projectKey,
            ReactorNodeType.CONTAINER,
            rootId,
            `${rootId}`,
            {
              kind: "jira-project",
              projectKey,
              site,
              url: `https://${site}/browse/${projectKey}`,
            }
          ),
        ],
      };

      const jql = `project = ${projectKey}${opts.jql ? ` AND (${opts.jql})` : ""} ORDER BY updated DESC`;
      let fetched = 0;
      let nextPageToken: string | undefined;
      let total = Infinity;

      while (fetched < maxIssues && fetched < total) {
        const page = await reader.searchIssues(jql, fetched, Math.min(pageSize, maxIssues - fetched), {
          extraFields,
          nextPageToken,
        });
        const issues = page.issues || [];
        if (issues.length === 0) break;
        total = typeof page.total === "number" ? page.total : total;
        nextPageToken = page.nextPageToken;

        const nodes: Partial<ReactorNode>[] = [];
        const edges: ReactorNodeLink[] = [];
        const searchables: any[] = [];

        for (const issue of issues) {
          const ticket = this.ticketNode(project, site, projectKey, issue, containerId, rootId);
          fullTicketIds.add(ticket.id as number);
          nodes.push(ticket);

          // searchable (never for stubs; comments opt-in)
          const logicalKey = sourceLogicalKey(SCHEME, site, projectKey, issue.key);
          const contentParts = [issue.summary, issue.description || ""];
          if (issue.labels?.length) contentParts.push(issue.labels.join(" "));
          if (opts.includeComments && issue.comments?.length) {
            contentParts.push(issue.comments.map((c) => c.body).join("\n"));
          }
          searchables.push({
            id: logicalKey,
            nodeId: ticket.id,
            name: `${issue.key} ${issue.summary}`,
            nameSpace: project.nameSpace,
            version: project.version,
            source: contentParts.filter(Boolean).join("\n").slice(0, 100_000),
            path: `${projectKey}/${issue.key}`,
            relativePath: `${projectKey}/${issue.key}`,
            type: { id: "ticket", name: "ticket" },
          });

          // assignee → PERSON + ASSIGNED_TO (display identity only, never emails)
          if (issue.assignee?.accountId) {
            const personId = nodeId(
              sourceLogicalKey(SCHEME, site, undefined, `person:${issue.assignee.accountId}`)
            );
            if (!personIds.has(personId)) {
              personIds.add(personId);
              nodes.push(
                this.baseNode(
                  project,
                  personId,
                  issue.assignee.displayName || issue.assignee.accountId,
                  ReactorNodeType.PERSON,
                  rootId,
                  `${rootId}`,
                  {
                    kind: "person",
                    accountId: issue.assignee.accountId,
                    displayName: issue.assignee.displayName,
                  }
                )
              );
            }
            edges.push({
              id: linkId(ticket.id as number, personId, ReactorLinkType.ASSIGNED_TO),
              source: ticket.id as number,
              target: personId,
              types: [ReactorLinkType.ASSIGNED_TO],
              title: issue.assignee.displayName,
            } as ReactorNodeLink);
          }

          // issue links → BLOCKS / DUPLICATES / RELATES (+ stubs for unseen targets)
          for (const link of issue.issueLinks || []) {
            if (!link.otherIssueKey) continue;
            const otherProjectKey = link.otherIssueKey.split("-")[0];
            const otherId = nodeId(
              sourceLogicalKey(SCHEME, site, otherProjectKey, link.otherIssueKey)
            );
            if (!fullTicketIds.has(otherId)) {
              nodes.push(
                this.stubTicketNode(project, site, link.otherIssueKey, rootId, link.otherIssueSummary)
              );
            }
            const type = this.linkTypeFor(link.typeName);
            const [src, dst] =
              link.direction === "outward"
                ? [ticket.id as number, otherId]
                : [otherId, ticket.id as number];
            edges.push({
              id: linkId(src, dst, type),
              source: src,
              target: dst,
              types: [type],
              title: link.typeName || type,
            } as ReactorNodeLink);
          }

          // parent (epic / subtask parent) → PART_OF
          if (issue.parent?.key) {
            const parentProjectKey = issue.parent.key.split("-")[0];
            const parentId = nodeId(
              sourceLogicalKey(SCHEME, site, parentProjectKey, issue.parent.key)
            );
            if (!fullTicketIds.has(parentId)) {
              nodes.push(this.stubTicketNode(project, site, issue.parent.key, rootId));
            }
            edges.push({
              id: linkId(ticket.id as number, parentId, ReactorLinkType.PART_OF),
              source: ticket.id as number,
              target: parentId,
              types: [ReactorLinkType.PART_OF],
              title: issue.parent.issueTypeName || "parent",
            } as ReactorNodeLink);
          }

          // sprint memberships → PART_OF (sprint stub now; board phase upserts the full node)
          for (const sprint of issue.sprints || []) {
            if (sprint.boardId === undefined || sprint.boardId === null) continue;
            const boardNodeId = nodeId(
              sourceLogicalKey(SCHEME, site, `${projectKey}/boards`, String(sprint.boardId))
            );
            const sprintNodeId = nodeId(
              sourceLogicalKey(SCHEME, site, `${projectKey}/boards/${sprint.boardId}`, `sprint-${sprint.id}`)
            );
            if (!sprintIdsEmitted.has(sprintNodeId)) {
              sprintIdsEmitted.add(sprintNodeId);
              nodes.push(
                this.baseNode(
                  project,
                  sprintNodeId,
                  sprint.name || `Sprint ${sprint.id}`,
                  ReactorNodeType.SPRINT,
                  boardNodeId,
                  `${containerKey}|${boardNodeId}`,
                  { kind: "sprint", sprintId: sprint.id, state: sprint.state, boardId: sprint.boardId, stub: true }
                )
              );
            }
            edges.push({
              id: linkId(ticket.id as number, sprintNodeId, ReactorLinkType.PART_OF),
              source: ticket.id as number,
              target: sprintNodeId,
              types: [ReactorLinkType.PART_OF],
              title: sprint.name || `sprint ${sprint.id}`,
            } as ReactorNodeLink);
            // board membership derived from the sprint's board (backlog-only
            // tickets carry no board edge — deriving those needs per-board JQL).
            edges.push({
              id: linkId(ticket.id as number, boardNodeId, ReactorLinkType.PART_OF),
              source: ticket.id as number,
              target: boardNodeId,
              types: [ReactorLinkType.PART_OF],
              title: "board",
            } as ReactorNodeLink);
          }
        }

        yield { nodes, edges, searchables };
        fetched += issues.length;

        if (page.isLast === true) break;
        if (page.isLast === undefined && issues.length < pageSize && !nextPageToken) break;
      }

      if (fetched >= maxIssues && fetched < total) {
        this.context.warn(
          `jira snapshot truncated for ${site}/${projectKey}: fetched ${fetched} of ${total} issues (maxIssuesPerProject=${maxIssues})`
        );
      }

      // boards + sprints (full nodes; upsert over any sprint stubs from the issue phase)
      if (opts.includeBoards !== false) {
        let boards: JiraBoard[] = [];
        try {
          boards = (await reader.getBoards(projectKey)) || [];
        } catch (err) {
          this.context.warn(
            `jira getBoards failed for ${site}/${projectKey}: ${(err as Error).message}`
          );
        }
        for (const board of boards) {
          if (board.location?.projectKey && board.location.projectKey.toUpperCase() !== projectKey) {
            continue;
          }
          const boardNodeId = nodeId(
            sourceLogicalKey(SCHEME, site, `${projectKey}/boards`, String(board.id))
          );
          const nodes: Partial<ReactorNode>[] = [
            this.baseNode(
              project,
              boardNodeId,
              board.name,
              ReactorNodeType.BOARD,
              containerId,
              containerKey,
              { kind: "board", boardId: board.id, boardType: board.type, projectKey }
            ),
          ];
          try {
            const sprints = (await reader.getSprints(board.id, "active,future,closed")) || [];
            for (const sprint of sprints) {
              const sprintNodeId = nodeId(
                sourceLogicalKey(SCHEME, site, `${projectKey}/boards/${board.id}`, `sprint-${sprint.id}`)
              );
              sprintIdsEmitted.add(sprintNodeId);
              nodes.push(
                this.baseNode(
                  project,
                  sprintNodeId,
                  sprint.name,
                  ReactorNodeType.SPRINT,
                  boardNodeId,
                  `${containerKey}|${boardNodeId}`,
                  {
                    kind: "sprint",
                    sprintId: sprint.id,
                    state: sprint.state,
                    boardId: board.id,
                    goal: sprint.goal,
                    startDate: sprint.startDate,
                    endDate: sprint.endDate,
                  }
                )
              );
            }
          } catch (err) {
            this.context.warn(
              `jira getSprints failed for board ${board.id} (${site}/${projectKey}): ${(err as Error).message}`
            );
          }
          yield { nodes };
        }
      }
    }
  }
}

export default JiraGraphProvider;
