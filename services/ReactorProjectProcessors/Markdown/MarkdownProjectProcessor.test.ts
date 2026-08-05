import MarkdownProjectProcessor from "./MarkdownProjectProcessor";
import NodeJSProjectProcessor from "../NodeJS/NodeJSProjectProcessor";
import { makeContext, writeProject, cleanup, fileId } from "../../graph/testUtils";
import {
  ReactorLinkType,
  ReactorNodeType,
} from "../../../types/model.types";
import { nodeId, projectFqn, symbolLogicalKey } from "../../graph/GraphIdentity";

/** Captures what process() would persist/index, without Mongo or a search index. */
const capturing = <T extends new (...args: any[]) => any>(Base: T) =>
  class extends Base {
    public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
    public capturedSearchables: any[] = [];
    protected async persistGraph(nodes: any[], edges: any[]) {
      this.captured = { nodes, edges };
    }
    protected async indexSearchables(_project: any, searchables: any[]) {
      this.capturedSearchables = searchables;
    }
  };

const CapturingMarkdown = capturing(MarkdownProjectProcessor);
const CapturingNodeJS = capturing(NodeJSProjectProcessor);

describe("MarkdownProjectProcessor - detection", () => {
  const processor = new MarkdownProjectProcessor({}, makeContext());

  it("detects a markdown project and reports its dialects", () => {
    const md = writeProject({ "README.md": "# Hello\n" });
    expect(processor.supportsProject(md.project)).toBe(true);
    expect(processor.getProjectTypes(md.project)).toEqual(["documentation", "markdown"]);
    cleanup(md.dir);
  });

  it("detects documents nested in a conventional docs directory", () => {
    const docs = writeProject({ "docs/guide.md": "# Guide\n" });
    expect(processor.supportsProject(docs.project)).toBe(true);
    cleanup(docs.dir);

    const adr = writeProject({ "adr/0001-choice.md": "# Choice\n" });
    expect(processor.supportsProject(adr.project)).toBe(true);
    cleanup(adr.dir);
  });

  it("detects a docs site by its config even before scanning content", () => {
    const site = writeProject({ "mkdocs.yml": "site_name: Docs\n" });
    expect(processor.supportsProject(site.project)).toBe(true);
    cleanup(site.dir);
  });

  it("reports every dialect present", () => {
    const mixed = writeProject({
      "README.md": "# a\n",
      "docs/api.rst": "API\n===\n",
      "docs/notes.adoc": "= Notes\n",
      "NOTES.txt": "notes\n",
    });
    const types = processor.getProjectTypes(mixed.project);
    expect(types).toEqual(
      expect.arrayContaining([
        "documentation",
        "markdown",
        "restructuredtext",
        "asciidoc",
        "plaintext",
      ])
    );
    cleanup(mixed.dir);
  });

  it("does not claim a project with no documents", () => {
    const foreign = writeProject({ "package.json": "{}", "src/index.ts": "" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    expect(processor.getProjectTypes(foreign.project)).toEqual([]);
    cleanup(foreign.dir);
  });

  it("does not descend into ignored directories when detecting", () => {
    const noisy = writeProject({ "node_modules/pkg/README.md": "# dep\n" });
    expect(noisy.project.repoPath).toBeDefined();
    expect(processor.supportsProject(noisy.project)).toBe(false);
    cleanup(noisy.dir);
  });
});

describe("MarkdownProjectProcessor - documentation-only project", () => {
  const files = {
    "README.md":
      "---\ntitle: Handbook\ntags: [onboarding, process]\n---\n\n" +
      "# Handbook\n\n" +
      "## Getting Started\n\nStart with [the setup guide](./docs/setup.md#install).\n\n" +
      "## Diagrams\n\n![overview](./docs/img/overview.png)\n",
    "docs/setup.md":
      "---\ntags: [onboarding]\n---\n\n# Setup\n\n## Install\n\nSee <https://example.com/tools>.\n",
    "docs/img/overview.png": "binary-ish",
  };

  it("builds sections, cross-document links, topics and resources", async () => {
    const { dir, project } = writeProject(files);
    const processor = new CapturingMarkdown({}, makeContext());
    await processor.process(project);

    const { nodes, edges } = processor.captured;
    const fqn = projectFqn(project);
    const byType = (type: ReactorNodeType) => nodes.filter((n) => n.type === type);

    // Document nodes are typed DOCUMENT, not FILE.
    const documents = byType(ReactorNodeType.DOCUMENT).map((n) => n.name).sort();
    expect(documents).toEqual(["README.md", "setup.md"]);

    // Sections from both documents, nested under their document.
    const sections = byType(ReactorNodeType.SECTION);
    expect(sections.map((s) => s.name).sort()).toEqual([
      "Diagrams",
      "Getting Started",
      "Handbook",
      "Install",
      "Setup",
    ]);

    // The tag shared by both documents collapses to one project-scoped node.
    const topics = byType(ReactorNodeType.TOPIC);
    expect(topics.map((t) => t.name).sort()).toEqual(["onboarding", "process"]);
    const onboarding = topics.find((t) => t.name === "onboarding")!;
    expect(edges.filter((e) => e.target === onboarding.id)).toHaveLength(2);

    // An external URL becomes a RESOURCE node.
    expect(byType(ReactorNodeType.RESOURCE).map((r) => r.data.host)).toEqual(["example.com"]);

    // The cross-document anchor link lands on setup.md's "Install" section.
    const installId = nodeId(symbolLogicalKey(fqn, "docs/setup.md", "install"));
    expect(sections.some((s) => s.id === installId)).toBe(true);
    expect(
      edges.some((e) => e.target === installId && e.types.includes(ReactorLinkType.REFERENCE))
    ).toBe(true);

    // The embedded image is claimed as a node (nothing else walks this project)
    // so the EMBEDS edge has a real endpoint.
    const imageId = fileId(project, "docs/img/overview.png");
    expect(nodes.some((n) => n.id === imageId)).toBe(true);
    expect(
      edges.some((e) => e.target === imageId && e.types.includes(ReactorLinkType.EMBEDS))
    ).toBe(true);

    cleanup(dir);
  });

  it("leaves no edge pointing at a node it did not create", async () => {
    const { dir, project } = writeProject(files);
    const processor = new CapturingMarkdown({}, makeContext());
    await processor.process(project);
    const ids = new Set(processor.captured.nodes.map((n) => n.id));
    const dangling = processor.captured.edges.filter(
      (e) => !ids.has(e.source) || !ids.has(e.target)
    );
    expect(dangling).toEqual([]);
    cleanup(dir);
  });

  it("lifts each document's title onto its node", async () => {
    const { dir, project } = writeProject(files);
    const processor = new CapturingMarkdown({}, makeContext());
    await processor.process(project);
    const readme = processor.captured.nodes.find((n) => n.name === "README.md")!;
    expect(readme.description).toBe("Handbook (README.md)");
    expect(readme.data).toMatchObject({
      kind: "document",
      documentTitle: "Handbook",
      tags: ["onboarding", "process"],
    });
    cleanup(dir);
  });

  it("expands a document into its sections when browsing the tree", async () => {
    const { dir, project } = writeProject(files);
    const processor = new MarkdownProjectProcessor({}, makeContext());
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);

    const readme = children.find((c) => c.name === "README.md")!;
    expect(readme.type).toBe(ReactorNodeType.DOCUMENT);
    expect(children.find((c) => c.name === "docs")!.type).toBe(ReactorNodeType.FOLDER);

    const sections = await processor.getChildrenForNode(readme as any, readme.key, null, null);
    expect(sections.map((s) => s.name)).toEqual(["Handbook", "Getting Started", "Diagrams"]);
    expect(sections.every((s) => s.type === ReactorNodeType.SECTION)).toBe(true);
    cleanup(dir);
  });
});

describe("Hybrid project (code + documentation)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "svc", version: "1.0.0" }),
    "README.md":
      "# Service\n\n## Overview\n\nThe entry point is [src/index.ts](./src/index.ts).\n",
    "src/index.ts": "export function main() { return 1; }\n",
  };

  it("graphs documents and code in one pass from the code processor", async () => {
    const { dir, project } = writeProject(files);
    const processor = new CapturingNodeJS({}, makeContext());
    await processor.process(project);

    const { nodes, edges } = processor.captured;
    // Code symbols are still extracted.
    expect(nodes.some((n) => n.name === "main" && n.type === ReactorNodeType.FUNCTION)).toBe(true);
    // ...and the README is outlined by the base document analyzer.
    expect(nodes.some((n) => n.name === "Overview" && n.type === ReactorNodeType.SECTION)).toBe(
      true
    );
    // ...and tied to the code it documents.
    const documentsEdge = edges.find((e) =>
      (e.types || []).includes(ReactorLinkType.DOCUMENTS)
    );
    expect(documentsEdge).toBeDefined();
    expect(documentsEdge!.target).toBe(fileId(project, "src/index.ts"));
    cleanup(dir);
  });

  it("does not let the markdown processor take ownership of source nodes", async () => {
    const { dir, project } = writeProject(files);
    // As ReactorProjectService would configure a hybrid project.
    const hybrid = {
      ...project,
      processors: [
        { id: "nodejs", processor: "reactor.NodeJSProjectProcessor@1.0.0" },
        { id: "markdown", processor: "reactor.MarkdownProjectProcessor@1.0.0" },
      ],
    };

    const markdown = new CapturingMarkdown({}, makeContext());
    await markdown.process(hybrid);

    const claimed = markdown.captured.nodes
      .filter((n) => n.type === ReactorNodeType.FILE || n.type === ReactorNodeType.DOCUMENT)
      .map((n) => n.name);
    // Only the document - src/index.ts and package.json belong to NodeJS.
    expect(claimed).toEqual(["README.md"]);
    cleanup(dir);
  });

  it("claims every file when it is the project's only processor", async () => {
    const { dir, project } = writeProject(files);
    const markdown = new CapturingMarkdown({}, makeContext());
    await markdown.process({
      ...project,
      processors: [{ id: "markdown", processor: "reactor.MarkdownProjectProcessor@1.0.0" }],
    });
    const claimed = markdown.captured.nodes
      .filter((n) => n.type === ReactorNodeType.FILE || n.type === ReactorNodeType.DOCUMENT)
      .map((n) => n.name)
      .sort();
    expect(claimed).toEqual(["README.md", "index.ts", "package.json"]);
    cleanup(dir);
  });
});
