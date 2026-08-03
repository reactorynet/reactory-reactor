import MarkdownProjectProcessor from "./MarkdownProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("MarkdownProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new MarkdownProjectProcessor({}, ctx);

  it("detects markdown/docs projects", () => {
    const md = writeProject({ "README.md": "# Hello\n" });
    expect(processor.supportsProject(md.project)).toBe(true);
    expect(processor.getProjectTypes(md.project)).toEqual(["documentation", "markdown"]);
    cleanup(md.dir);

    const docs = writeProject({ "docs/index.txt": "hi" });
    expect(processor.supportsProject(docs.project)).toBe(true);
    cleanup(docs.dir);

    const foreign = writeProject({ "package.json": "{}" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    cleanup(foreign.dir);
  });

  it("process() creates heading symbols and REFERENCE edges between linked files", async () => {
    class CapturingProcessor extends MarkdownProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {
        /* skip search indexing in tests */
      }
    }
    const { dir, project } = writeProject({
      "README.md": "# Title\n\nSee the [guide](./docs/guide.md) for details.\n\n## Section\n",
      "docs/guide.md": "# Guide\n\n## Setup\n",
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);

    const names = p.captured.nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["Title", "Section", "Guide", "Setup"]));

    const reference = p.captured.edges.find((e) => e.types?.includes("REFERENCE"));
    expect(reference).toBeDefined();
    cleanup(dir);
  });

  it("does not create edges for external links or anchors", async () => {
    class CapturingProcessor extends MarkdownProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {}
    }
    const { dir, project } = writeProject({
      "README.md": "# Title\n\n[external](https://example.com) and [anchor](#title)\n",
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);
    expect(p.captured.edges.length).toBe(0);
    cleanup(dir);
  });

  it("walks the file tree generically (inherited from the base)", async () => {
    const { dir, project } = writeProject({
      "README.md": "# Hello\n",
      "docs/guide.md": "# Guide\n",
    });
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("docs");
    expect(names).toContain("README.md");
    const docs = children.find((c) => c.name === "docs")!;
    expect(docs.type).toBe(ReactorNodeType.FOLDER);
    cleanup(dir);
  });
});
