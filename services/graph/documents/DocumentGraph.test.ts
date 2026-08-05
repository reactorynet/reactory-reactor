import path from "path";
import { ReactorLinkType, ReactorNodeType } from "../../../types/model.types";
import { nodeId, pathLogicalKey, projectFqn, symbolLogicalKey } from "../GraphIdentity";
import { cleanup, fileNodeFor, writeProject, TestProject } from "../testUtils";
import { analyseDocumentFile, documentFormatFor, isDocumentFile } from ".";
import {
  normalizeExternalUrl,
  resolveDocumentTarget,
  sanitizeFrontmatter,
} from "./DocumentGraphEmitter";

/** Deterministic section node id, as another document would compute it. */
const sectionId = (project: TestProject, rel: string, slug: string): number =>
  nodeId(symbolLogicalKey(projectFqn(project), rel, slug));

const fileId = (project: TestProject, rel: string): number =>
  nodeId(pathLogicalKey(projectFqn(project), rel));

/** A DOCUMENT file node, as the base processor builds one. */
const docNodeFor = (project: TestProject, rel: string) =>
  fileNodeFor(project, rel, documentFormatFor(rel) || "markdown");

describe("documentFormatFor / isDocumentFile", () => {
  it("recognises document extensions and bare document names", () => {
    expect(documentFormatFor("README.md")).toBe("markdown");
    expect(documentFormatFor("guide.MDX")).toBe("mdx");
    expect(documentFormatFor("api.rst")).toBe("restructuredtext");
    expect(documentFormatFor("notes.adoc")).toBe("asciidoc");
    expect(documentFormatFor("notes.txt")).toBe("text");
    expect(documentFormatFor("CHANGELOG")).toBe("text");
    expect(documentFormatFor("LICENSE")).toBe("text");
  });

  it("does not claim source or unrelated files", () => {
    expect(documentFormatFor("index.ts")).toBeNull();
    expect(documentFormatFor("package.json")).toBeNull();
    expect(documentFormatFor("README.bak")).toBeNull();
    expect(documentFormatFor("logo.png")).toBeNull();
    expect(isDocumentFile("index.ts", "typescript")).toBe(false);
    expect(isDocumentFile("index.ts", "markdown")).toBe(true); // language wins
  });
});

describe("normalizeExternalUrl", () => {
  it("collapses case, default ports and fragments to one identity", () => {
    expect(normalizeExternalUrl("HTTPS://Example.COM/a#frag")).toBe("https://example.com/a");
    expect(normalizeExternalUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeExternalUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeExternalUrl("//cdn.example.com/x")).toBe("https://cdn.example.com/x");
  });

  it("returns unparseable destinations unchanged", () => {
    expect(normalizeExternalUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(normalizeExternalUrl("not a url")).toBe("not a url");
  });
});

describe("sanitizeFrontmatter", () => {
  it("rewrites keys MongoDB rejects as field names", () => {
    expect(
      sanitizeFrontmatter({ "build.number": 3, $set: "x", nested: { "a.b": 1 } })
    ).toEqual({ build_number: 3, _set: "x", nested: { a_b: 1 } });
  });

  it("normalises dates and bounds strings, depth and breadth", () => {
    const date = new Date("2024-01-02T03:04:05.000Z");
    expect(sanitizeFrontmatter({ reviewed: date })).toEqual({
      reviewed: "2024-01-02T03:04:05.000Z",
    });

    const long = sanitizeFrontmatter({ text: "x".repeat(5000) }) as any;
    expect(long.text).toHaveLength(2000);

    // A structure deeper than the cap is truncated, not rejected wholesale.
    let deep: any = "leaf";
    for (let i = 0; i < 12; i++) deep = { down: deep };
    const trimmed = JSON.stringify(sanitizeFrontmatter(deep));
    expect(trimmed).toContain("down");
    expect(trimmed).not.toContain("leaf");
  });

  it("passes scalars and arrays through unchanged", () => {
    expect(sanitizeFrontmatter({ a: 1, b: true, c: ["x", "y"] })).toEqual({
      a: 1,
      b: true,
      c: ["x", "y"],
    });
  });
});

describe("resolveDocumentTarget", () => {
  let dir: string;
  let project: TestProject;

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "README.md": "# root",
      "docs/guide.md": "# guide",
      "docs/nested/index.md": "# nested index",
      "src/index.ts": "export const x = 1;",
    }));
  });
  afterAll(() => cleanup(dir));

  const from = (rel: string) => path.join(project.repoPath, rel);

  it("resolves relative, parent-relative and root-relative destinations", () => {
    expect(resolveDocumentTarget("./docs/guide.md", from("README.md"), dir)?.relativePath).toBe(
      "docs/guide.md"
    );
    expect(resolveDocumentTarget("../README.md", from("docs/guide.md"), dir)?.relativePath).toBe(
      "README.md"
    );
    expect(resolveDocumentTarget("/docs/guide.md", from("README.md"), dir)?.relativePath).toBe(
      "docs/guide.md"
    );
  });

  it("resolves extension-less links and directory indexes", () => {
    expect(resolveDocumentTarget("./docs/guide", from("README.md"), dir)?.relativePath).toBe(
      "docs/guide.md"
    );
    const index = resolveDocumentTarget("./docs/nested", from("README.md"), dir);
    expect(index?.relativePath).toBe("docs/nested/index.md");
    expect(index?.isDirectory).toBe(false);
  });

  it("returns a directory when it has no index document", () => {
    const target = resolveDocumentTarget("./src", from("README.md"), dir);
    expect(target).toMatchObject({ relativePath: "src", isDirectory: true });
  });

  it("splits off anchors and query strings", () => {
    const target = resolveDocumentTarget("./docs/guide.md#Getting%20Started", from("README.md"), dir);
    expect(target).toMatchObject({ relativePath: "docs/guide.md", anchor: "getting-started" });
    expect(resolveDocumentTarget("./docs/guide.md?v=2", from("README.md"), dir)?.relativePath).toBe(
      "docs/guide.md"
    );
  });

  it("refuses URLs, missing files and paths escaping the repo", () => {
    expect(resolveDocumentTarget("https://example.com", from("README.md"), dir)).toBeNull();
    expect(resolveDocumentTarget("./missing.md", from("README.md"), dir)).toBeNull();
    expect(resolveDocumentTarget("../../../etc/hosts", from("README.md"), dir)).toBeNull();
    expect(resolveDocumentTarget("#anchor-only", from("README.md"), dir)).toBeNull();
  });
});

describe("analyseDocumentFile - sections", () => {
  let dir: string;
  let project: TestProject;

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "README.md":
        "---\ntitle: Payments Service\ntags: [payments, pci]\n---\n\n" +
        "# Payments Service\n\nIntro prose.\n\n" +
        "## Architecture\n\nSee [the design](./docs/design.md#data-flow).\n\n" +
        "### Data Stores\n\nDefined in [src/db.ts](./src/db.ts).\n",
      "docs/design.md": "# Design\n\n## Data Flow\n\nBody.\n",
      "src/db.ts": "export const db = 1;",
    }));
  });
  afterAll(() => cleanup(dir));

  it("emits nested SECTION nodes with anchor-keyed deterministic ids", () => {
    const graph = analyseDocumentFile(docNodeFor(project, "README.md"));
    const byName = new Map(graph.symbols.map((s) => [s.name, s]));

    expect([...byName.keys()]).toEqual(["Payments Service", "Architecture", "Data Stores"]);
    expect(byName.get("Architecture")!.type).toBe(ReactorNodeType.SECTION);

    // Id is a function of (project, path, anchor slug) only - so any other
    // document can compute it from `README.md#architecture`.
    expect(byName.get("Architecture")!.id).toBe(sectionId(project, "README.md", "architecture"));

    // Hierarchy lives in parentId: h1 -> file, h2 -> h1, h3 -> h2.
    const doc = docNodeFor(project, "README.md");
    expect(byName.get("Payments Service")!.parentId).toBe(doc.id);
    expect(byName.get("Architecture")!.parentId).toBe(byName.get("Payments Service")!.id);
    expect(byName.get("Data Stores")!.parentId).toBe(byName.get("Architecture")!.id);

    // Ancestry keys chain from the document node.
    expect(byName.get("Architecture")!.key).toBe(
      `${doc.key}|${byName.get("Payments Service")!.id}|${byName.get("Architecture")!.id}`
    );
  });

  it("carries section position and prevents filesystem expansion", () => {
    const graph = analyseDocumentFile(docNodeFor(project, "README.md"));
    const architecture = graph.symbols.find((s) => s.name === "Architecture")!;
    expect(architecture.data).toMatchObject({
      kind: "section",
      slug: "architecture",
      level: 2,
      noExpand: true,
      relativePath: "README.md",
    });
    expect(architecture.data.line).toBe(10);
    expect(architecture.data.endLine).toBeGreaterThanOrEqual(architecture.data.line);
  });

  it("lifts the document's title, frontmatter and outline onto the file node", () => {
    const graph = analyseDocumentFile(docNodeFor(project, "README.md"));
    expect(graph.filePatch.description).toBe("Payments Service (README.md)");
    expect(graph.filePatch.data).toMatchObject({
      kind: "document",
      documentFormat: "markdown",
      documentTitle: "Payments Service",
      tags: ["payments", "pci"],
    });
    expect(graph.filePatch.data!.headings).toHaveLength(3);
    expect(graph.filePatch.data!.documentMetrics.sections).toBe(3);
  });

  it("is idempotent - the same document analysed twice yields the same ids", () => {
    const first = analyseDocumentFile(docNodeFor(project, "README.md"));
    const second = analyseDocumentFile(docNodeFor(project, "README.md"));
    expect(second.symbols.map((s) => s.id)).toEqual(first.symbols.map((s) => s.id));
    expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));
  });
});

describe("analyseDocumentFile - edges", () => {
  let dir: string;
  let project: TestProject;

  beforeAll(() => {
    ({ dir, project } = writeProject({
      "README.md":
        "---\ntitle: Service\ntags: [auth]\nrelated: [./docs/design.md]\n---\n\n" +
        "# Service\n\n" +
        "## Overview\n\n" +
        "Read [the design](./docs/design.md#data-flow) first, or jump to [setup](#setup).\n" +
        "The entry point is [src/index.ts](./src/index.ts) and config lives in `src/config.json`.\n" +
        "![architecture](./docs/img/arch.png)\n" +
        "Dashboards: <https://grafana.example.com/d/abc>\n\n" +
        "## Setup\n\nRun it.\n",
      "docs/design.md": "# Design\n\n## Data Flow\n\nBody.\n",
      "docs/img/arch.png": "not-really-a-png",
      "src/index.ts": "export const x = 1;",
      "src/config.json": "{}",
    }));
  });
  afterAll(() => cleanup(dir));

  const analyse = () => analyseDocumentFile(docNodeFor(project, "README.md"));

  const edgeTo = (target: number, type?: ReactorLinkType) =>
    analyse().edges.find(
      (e) => e.target === target && (!type || (e.types || []).includes(type))
    );

  it("links a cross-document anchor to the target document's SECTION node", () => {
    // Computed from the anchor alone - docs/design.md is never parsed here.
    const target = sectionId(project, "docs/design.md", "data-flow");
    const edge = edgeTo(target, ReactorLinkType.REFERENCE);
    expect(edge).toBeDefined();
    expect(edge!.data).toMatchObject({ resolved: "docs/design.md", anchor: "data-flow" });

    // The section id the emitter targeted is exactly the one design.md produces.
    const designSections = analyseDocumentFile(docNodeFor(project, "docs/design.md")).symbols;
    expect(designSections.map((s) => s.id)).toContain(target);
  });

  it("also links the documents themselves, for a file-level view", () => {
    expect(edgeTo(fileId(project, "docs/design.md"), ReactorLinkType.REFERENCE)).toBeDefined();
  });

  it("emits DOCUMENTS edges from a document to the code it describes", () => {
    const edge = edgeTo(fileId(project, "src/index.ts"), ReactorLinkType.DOCUMENTS);
    expect(edge).toBeDefined();
    expect(edge!.types).toEqual([ReactorLinkType.DOCUMENTS, ReactorLinkType.REFERENCE]);
    expect(edge!.description).toContain("documents src/index.ts");
  });

  it("emits DOCUMENTS edges for path-like code spans", () => {
    const edge = edgeTo(fileId(project, "src/config.json"), ReactorLinkType.DOCUMENTS);
    expect(edge).toBeDefined();
    expect(edge!.data).toMatchObject({ kind: "code-span" });
  });

  it("emits EMBEDS edges for images", () => {
    const edge = edgeTo(fileId(project, "docs/img/arch.png"), ReactorLinkType.EMBEDS);
    expect(edge).toBeDefined();
  });

  it("originates edges from the section that contains the reference", () => {
    const graph = analyse();
    const overview = graph.symbols.find((s) => s.name === "Overview")!;
    const edge = graph.edges.find((e) => e.target === fileId(project, "src/index.ts"))!;
    expect(edge.source).toBe(overview.id);
  });

  it("resolves intra-document anchors to the local section", () => {
    const graph = analyse();
    const setup = graph.symbols.find((s) => s.name === "Setup")!;
    const edge = graph.edges.find((e) => e.target === setup.id && e.data?.internal === true);
    expect(edge).toBeDefined();
  });

  it("creates a RESOURCE node per external URL and references it", () => {
    const graph = analyse();
    const resource = graph.externals.find((n) => n.type === ReactorNodeType.RESOURCE)!;
    expect(resource).toBeDefined();
    expect(resource.data).toMatchObject({
      kind: "resource",
      url: "https://grafana.example.com/d/abc",
      host: "grafana.example.com",
      scheme: "https",
    });
    expect(graph.edges.some((e) => e.target === resource.id)).toBe(true);
  });

  it("creates project-scoped TOPIC nodes from frontmatter tags", () => {
    const graph = analyse();
    const topic = graph.externals.find((n) => n.type === ReactorNodeType.TOPIC)!;
    expect(topic).toMatchObject({ name: "auth" });
    // Parented to the project root and keyed on the project, so every document
    // in the project carrying "auth" attaches to this same node.
    expect(topic.parentId).toBe(nodeId(projectFqn(project)));
    expect(topic.id).toBe(nodeId(`topic:${projectFqn(project)}#auth`));
    const edge = graph.edges.find((e) => e.target === topic.id)!;
    expect(edge.types).toEqual([ReactorLinkType.MENTIONS]);
    expect(edge.source).toBe(docNodeFor(project, "README.md").id);
  });

  it("treats frontmatter `related` entries as document-level links", () => {
    // The same target is referenced from the body (inside "Overview") and from
    // frontmatter. These are different statements - "this section links there"
    // vs "this document relates to that" - so both edges exist, from different
    // source nodes.
    const graph = analyse();
    const target = fileId(project, "docs/design.md");
    const doc = docNodeFor(project, "README.md");
    const overview = graph.symbols.find((s) => s.name === "Overview")!;
    const sources = graph.edges.filter((e) => e.target === target).map((e) => e.source);
    expect(sources).toEqual(expect.arrayContaining([doc.id, overview.id]));
  });

  it("collapses repeated references that make the same statement", () => {
    const { dir: repeatDir, project: repeatProject } = writeProject({
      "README.md": "# T\n\n## S\n\n[a](./x.md) and again [a](./x.md) and [b](./x.md).\n",
      "x.md": "# X\n",
    });
    const graph = analyseDocumentFile(docNodeFor(repeatProject, "README.md"));
    const edges = graph.edges.filter((e) => e.target === fileId(repeatProject, "x.md"));
    expect(edges).toHaveLength(1);
    cleanup(repeatDir);
  });

  it("never emits an edge to something outside the repository", () => {
    const graph = analyse();
    const known = new Set([
      ...graph.symbols.map((n) => n.id),
      ...graph.externals.map((n) => n.id),
      docNodeFor(project, "README.md").id,
      fileId(project, "docs/design.md"),
      fileId(project, "docs/img/arch.png"),
      fileId(project, "src/index.ts"),
      fileId(project, "src/config.json"),
      sectionId(project, "docs/design.md", "data-flow"),
    ]);
    const dangling = graph.edges.filter(
      (e) => !known.has(e.source) || !known.has(e.target)
    );
    expect(dangling).toEqual([]);
  });
});

describe("analyseDocumentFile - resilience", () => {
  it("returns an empty graph for a missing file", () => {
    const { dir, project } = writeProject({ "README.md": "# x" });
    const node = docNodeFor(project, "gone.md");
    const graph = analyseDocumentFile(node);
    expect(graph).toEqual({ symbols: [], externals: [], edges: [], filePatch: {} });
    cleanup(dir);
  });

  it("returns an empty graph for a non-document file", () => {
    const { dir, project } = writeProject({ "src/index.ts": "export const x = 1;" });
    const graph = analyseDocumentFile(fileNodeFor(project, "src/index.ts", "typescript"));
    expect(graph.symbols).toHaveLength(0);
    cleanup(dir);
  });

  it("outlines a plain-text document", () => {
    const { dir, project } = writeProject({
      "NOTES.txt":
        "Release Notes\n=============\n\nSee https://example.com/changelog\n\n" +
        "1. Breaking Changes\n\nDetails here.\n",
    });
    const graph = analyseDocumentFile(docNodeFor(project, "NOTES.txt"));
    expect(graph.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Release Notes", "Breaking Changes"])
    );
    expect(graph.filePatch.data).toMatchObject({ documentFormat: "text" });
    expect(graph.externals.some((n) => n.type === ReactorNodeType.RESOURCE)).toBe(true);
    cleanup(dir);
  });

  it("handles a document with no structure at all", () => {
    const { dir, project } = writeProject({ "EMPTY.md": "" });
    const graph = analyseDocumentFile(docNodeFor(project, "EMPTY.md"));
    expect(graph.symbols).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.filePatch.description).toBe("Document EMPTY.md");
    cleanup(dir);
  });
});
