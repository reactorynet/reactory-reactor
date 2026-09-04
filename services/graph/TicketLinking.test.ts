import fs from "fs";
import path from "path";
import SystemGraphManager from "../SystemGraphManager";
import MarkdownProjectProcessor from "../ReactorProjectProcessors/Markdown/MarkdownProjectProcessor";
import { ReactorProjectModel } from "../../models/ReactorProject";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";
import { writeProject, cleanup } from "./testUtils";
import {
  linkId,
  nodeId,
  pathLogicalKey,
  projectFqn,
  projectLogicalKey,
  symbolLogicalKey,
} from "./GraphIdentity";
import {
  TicketSourceIndex,
  jiraProjectNodeIdFor,
  parseJiraUrl,
  scanTicketMentions,
  ticketNodeIdFor,
} from "./ticketLinking";
import { parseDocument } from "./documents";
import { ReactorLinkType, ReactorNodeType, ReactorNode, ReactorNodeLink } from "../../types/model.types";

const SITE = "fixture.atlassian.net";
const makeIndex = (): TicketSourceIndex =>
  new Map([
    ["WR", { site: SITE, sourceProjectId: "jira-src-1" }],
    ["PAY", { site: SITE, sourceProjectId: "jira-src-1" }],
  ]);

const makeContext = () => {
  const store = new Map<string, any>();
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: () => null,
    utils: { hash: (v: any) => nodeId(String(v)) },
    __store: store,
  } as any;
};

// ---------------------------------------------------------------------------
// scanTicketMentions / parseJiraUrl units
// ---------------------------------------------------------------------------

describe("ticketLinking — scanTicketMentions", () => {
  const doc = [
    "# Release notes",
    "",
    "## Fixes",
    "",
    "Resolved WR-123 and `WR-456` this sprint.",
    "Standards like UTF-8, SHA-256 and RFC-2119 must not link.",
    "Unregistered FAKE-9 must not link either.",
    "",
    "```",
    "git commit -m 'WR-789: fix'",
    "```",
  ].join("\n");
  const outline = parseDocument(doc, "markdown");

  it("finds registered keys with context-based confidence", () => {
    const mentions = scanTicketMentions(doc, outline, makeIndex());
    const byKey = new Map(mentions.map((m) => [m.ticketKey, m]));
    expect(byKey.get("WR-123")?.match).toBe("prose");
    expect(byKey.get("WR-123")?.confidence).toBe(0.85);
    expect(byKey.get("WR-456")?.match).toBe("inline-code");
    expect(byKey.get("WR-456")?.confidence).toBe(0.95);
    expect(byKey.get("WR-789")?.match).toBe("inline-code"); // fenced block
  });

  it("attributes mentions to the innermost containing section", () => {
    const mentions = scanTicketMentions(doc, outline, makeIndex());
    expect(mentions.find((m) => m.ticketKey === "WR-123")?.sectionSlug).toBe("fixes");
  });

  it("rejects denylisted and unregistered prefixes", () => {
    const keys = scanTicketMentions(doc, outline, makeIndex()).map((m) => m.ticketKey);
    expect(keys).not.toContain("UTF-8");
    expect(keys).not.toContain("SHA-256");
    expect(keys).not.toContain("RFC-2119");
    expect(keys).not.toContain("FAKE-9");
  });

  it("de-duplicates repeats within a section and scans without an outline", () => {
    const text = "WR-1 again WR-1 and WR-1";
    const mentions = scanTicketMentions(text, null, makeIndex());
    expect(mentions).toHaveLength(1);
    expect(mentions[0].sectionSlug).toBeUndefined();
  });

  it("returns nothing for an empty index (nothing registered → no links)", () => {
    expect(scanTicketMentions(doc, outline, new Map())).toEqual([]);
  });
});

describe("ticketLinking — parseJiraUrl", () => {
  it("parses browse ticket and project URLs", () => {
    expect(parseJiraUrl(`https://${SITE}/browse/WR-123`)).toEqual({
      host: SITE,
      projectKey: "WR",
      ticketKey: "WR-123",
    });
    expect(parseJiraUrl(`https://${SITE}/browse/WR`)).toEqual({ host: SITE, projectKey: "WR" });
  });

  it("parses software project/board URLs", () => {
    expect(parseJiraUrl(`https://${SITE}/jira/software/c/projects/PAY/boards/7`)).toEqual({
      host: SITE,
      projectKey: "PAY",
    });
  });

  it("rejects non-jira URLs", () => {
    expect(parseJiraUrl("https://example.com/some/page")).toBeNull();
    expect(parseJiraUrl("not a url")).toBeNull();
    expect(parseJiraUrl(`https://${SITE}/wiki/spaces/X`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// process() integration — mention pass through the Markdown processor
// ---------------------------------------------------------------------------

describe("ticket mention pass — process() integration", () => {
  let tempDir: string;
  let project: any;

  class TestableMarkdownProcessor extends MarkdownProjectProcessor {
    persistedEdges: ReactorNodeLink[] = [];
    existingNodeIds = new Set<number>();

    protected async loadTicketSourceIndex(): Promise<TicketSourceIndex> {
      return makeIndex();
    }

    protected async loadExistingNodeIds(ids: number[]): Promise<Set<number>> {
      return new Set(ids.filter((id) => this.existingNodeIds.has(id)));
    }

    protected async persistGraph(nodes: Partial<ReactorNode>[], edges: ReactorNodeLink[], meta?: any) {
      this.persistedEdges = edges;
      return { ok: true, nodeOps: nodes.length, edgeOps: edges.length };
    }

    protected async indexSearchables() {
      /* no-op */
    }
  }

  beforeEach(() => {
    const res = writeProject(
      {
        "docs/release.md": [
          "# Release",
          "",
          "## Fixes",
          "",
          "Shipped WR-123 and mentioned UTF-8 plus FAKE-9.",
        ].join("\n"),
      },
      { name: "docs-fixture", nameSpace: "test", version: "1.0.0" }
    );
    tempDir = res.dir;
    project = { ...res.project, id: "docs-proj-1" };
  });

  afterEach(() => {
    cleanup(tempDir);
    jest.restoreAllMocks();
  });

  it("emits a MENTIONS edge from the containing section to the computed ticket node", async () => {
    const proc = new TestableMarkdownProcessor({} as any, makeContext());
    await proc.process(project);

    const fqn = projectFqn(project);
    const sectionId = nodeId(symbolLogicalKey(fqn, "docs/release.md", "fixes"));
    const ticketId = ticketNodeIdFor(SITE, "WR-123");

    const mention = proc.persistedEdges.find(
      (e) => (e.types || []).includes(ReactorLinkType.MENTIONS) && e.data?.ticketKey === "WR-123"
    ) as any;
    expect(mention).toBeTruthy();
    expect(mention.source).toBe(sectionId);
    expect(mention.target).toBe(ticketId);
    expect(mention.id).toBe(linkId(sectionId, ticketId, ReactorLinkType.MENTIONS));
    expect(mention.data.match).toBe("prose");
    expect(mention.data.confidence).toBe(0.85);
    expect(mention.data.resolved).toBe(false); // ticket not synced yet

    // nothing for denylisted / unregistered keys
    const keys = proc.persistedEdges
      .filter((e) => (e.types || []).includes(ReactorLinkType.MENTIONS))
      .map((e: any) => e.data?.ticketKey)
      .filter(Boolean);
    expect(keys).not.toContain("UTF-8");
    expect(keys).not.toContain("FAKE-9");
  });

  it("stamps resolved: true when the ticket node exists", async () => {
    const proc = new TestableMarkdownProcessor({} as any, makeContext());
    proc.existingNodeIds.add(ticketNodeIdFor(SITE, "WR-123"));
    await proc.process(project);
    const mention = proc.persistedEdges.find((e: any) => e.data?.ticketKey === "WR-123") as any;
    expect(mention.data.resolved).toBe(true);
  });

  it("honours linkTicketMentions: false", async () => {
    const proc = new TestableMarkdownProcessor({} as any, makeContext());
    await proc.process(project, { linkTicketMentions: false } as any);
    expect(
      proc.persistedEdges.some((e: any) => e.data?.ticketKey)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SystemGraphManager.linkTicketMentions — resource URLs + tasksUrl
// ---------------------------------------------------------------------------

describe("SystemGraphManager.linkTicketMentions", () => {
  let ctx: any;
  let manager: SystemGraphManager;

  const jiraSourceProject = {
    _id: "jira-src-1",
    source: { scheme: "jira", sourceKey: SITE, options: { projectKeys: ["WR", "PAY"] } },
  };

  const resourceTicket: Partial<ReactorNode> = {
    id: 111,
    type: ReactorNodeType.RESOURCE,
    projectId: "docs-proj-1",
    data: { kind: "resource", url: `https://${SITE}/browse/WR-42` },
  };
  const resourceProjectUrl: Partial<ReactorNode> = {
    id: 222,
    type: ReactorNodeType.RESOURCE,
    projectId: "docs-proj-1",
    data: { kind: "resource", url: `https://${SITE}/browse/PAY` },
  };
  const resourceForeign: Partial<ReactorNode> = {
    id: 333,
    type: ReactorNodeType.RESOURCE,
    projectId: "docs-proj-1",
    data: { kind: "resource", url: "https://other.atlassian.net/browse/ZZ-1" },
  };
  const resourceUnregisteredKey: Partial<ReactorNode> = {
    id: 444,
    type: ReactorNodeType.RESOURCE,
    projectId: "docs-proj-1",
    data: { kind: "resource", url: `https://${SITE}/browse/GHOST-1` },
  };

  const repoProject = {
    _id: "repo-proj-1",
    name: "app-client",
    nameSpace: "reactor",
    version: "1.0.0",
    graphRootId: nodeId("reactor.app-client@1.0.0"),
    tasksUrl: `https://${SITE}/browse/WR`,
  };

  beforeEach(() => {
    ctx = makeContext();
    manager = new SystemGraphManager({} as any, ctx);
    jest.restoreAllMocks();
  });

  const mockModels = (opts: { existingTicketIds?: number[] } = {}) => {
    jest.spyOn(ReactorProjectModel, "find").mockImplementation((query: any) => {
      const isSourceQuery = query && query["source.scheme"] === "jira";
      const rows = isSourceQuery ? [jiraSourceProject] : [repoProject];
      return { select: () => ({ lean: async () => rows }), lean: async () => rows } as any;
    });
    jest.spyOn(ReactorNodeModel, "find").mockImplementation((query: any) => {
      if (query && query.type === ReactorNodeType.RESOURCE) {
        const rows = [resourceTicket, resourceProjectUrl, resourceForeign, resourceUnregisteredKey];
        return { lean: async () => rows } as any;
      }
      // existence check
      const ids: number[] = query?.id?.$in || [];
      const rows = ids
        .filter((id) => (opts.existingTicketIds || []).includes(id))
        .map((id) => ({ id }));
      return { select: () => ({ lean: async () => rows }), lean: async () => rows } as any;
    });
    return jest.spyOn(ReactorNodeLinkModel, "bulkWrite").mockResolvedValue({} as any);
  };

  it("links resource URLs and tasksUrl to computed Jira nodes (registered sites only)", async () => {
    const bulkWriteSpy = mockModels();
    const result = await manager.linkTicketMentions();

    expect(result.resourcesScanned).toBe(4);
    expect(result.projectsLinked).toBe(1);
    expect(result.createdLinks).toBe(3); // WR-42 + PAY project + tasksUrl; foreign + unregistered skipped

    const ops = bulkWriteSpy.mock.calls[0][0];
    const ids = ops.map((op: any) => op.updateOne.filter.id);
    expect(ids).toContain(linkId(111, ticketNodeIdFor(SITE, "WR-42"), ReactorLinkType.REFERENCE));
    expect(ids).toContain(linkId(222, jiraProjectNodeIdFor(SITE, "PAY"), ReactorLinkType.REFERENCE));
    expect(ids).toContain(
      linkId(repoProject.graphRootId, jiraProjectNodeIdFor(SITE, "WR"), ReactorLinkType.REFERENCE)
    );
    // manual runId on insert (GC-exempt)
    ops.forEach((op: any) => expect(op.updateOne.update.$setOnInsert.runId).toBe("manual"));
  });

  it("stamps data.resolved from target existence", async () => {
    const wr42 = ticketNodeIdFor(SITE, "WR-42");
    const bulkWriteSpy = mockModels({ existingTicketIds: [wr42] });
    await manager.linkTicketMentions();
    const ops = bulkWriteSpy.mock.calls[0][0];
    const ticketOp = ops.find((op: any) => op.updateOne.update.$set.target === wr42);
    const projectOp = ops.find(
      (op: any) => op.updateOne.update.$set.target === jiraProjectNodeIdFor(SITE, "PAY")
    );
    expect(ticketOp.updateOne.update.$set.data.resolved).toBe(true);
    expect(projectOp.updateOne.update.$set.data.resolved).toBe(false);
  });

  it("does nothing when no Jira sources are registered", async () => {
    jest.spyOn(ReactorProjectModel, "find").mockImplementation(() => ({
      select: () => ({ lean: async () => [] }),
      lean: async () => [],
    }) as any);
    const findSpy = jest.spyOn(ReactorNodeModel, "find");
    const result = await manager.linkTicketMentions();
    expect(result).toEqual({ createdLinks: 0, resourcesScanned: 0, projectsLinked: 0 });
    expect(findSpy).not.toHaveBeenCalled();
  });
});
