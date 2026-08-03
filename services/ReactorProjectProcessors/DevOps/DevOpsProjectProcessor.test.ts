import DevOpsProjectProcessor from "./DevOpsProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("DevOpsProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new DevOpsProjectProcessor({}, ctx);

  it("detects Helm/Atlantis/Terraform projects", () => {
    const chart = writeProject({ "Chart.yaml": "name: my-chart\nversion: 1.0.0\n" });
    expect(processor.supportsProject(chart.project)).toBe(true);
    expect(processor.getProjectTypes(chart.project)).toEqual([
      "devops",
      "kubernetes",
      "helm",
      "terraform",
    ]);
    cleanup(chart.dir);

    const atlantis = writeProject({ "atlantis.yaml": "version: 3\nprojects: []\n" });
    expect(processor.supportsProject(atlantis.project)).toBe(true);
    cleanup(atlantis.dir);

    const tf = writeProject({ "main.tf": 'resource "aws_s3_bucket" "logs" {}\n' });
    expect(processor.supportsProject(tf.project)).toBe(true);
    cleanup(tf.dir);

    const foreign = writeProject({ "package.json": "{}" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    cleanup(foreign.dir);
  });

  it("process() creates a chart symbol and DEPENDENCY edges from Chart.yaml", async () => {
    class CapturingProcessor extends DevOpsProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {}
    }
    const { dir, project } = writeProject({
      "Chart.yaml":
        "name: my-chart\nversion: 1.2.3\ndescription: test chart\ndependencies:\n  - name: redis\n    version: 1.0.0\n",
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);

    const names = p.captured.nodes.map((n) => n.name);
    expect(names).toContain("my-chart");

    const dependency = p.captured.edges.find((e) => e.types?.includes("DEPENDENCY"));
    expect(dependency).toBeDefined();
    expect(dependency.title).toContain("redis");
    cleanup(dir);
  });

  it("process() creates an Atlantis symbol from atlantis.yaml", async () => {
    class CapturingProcessor extends DevOpsProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {}
    }
    const { dir, project } = writeProject({
      "atlantis.yaml": "version: 3\nprojects:\n  - dir: .\n",
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);

    const names = p.captured.nodes.map((n) => n.name);
    expect(names).toContain("Atlantis Workflows");
    cleanup(dir);
  });

  it("process() creates symbols for Terraform resource declarations", async () => {
    class CapturingProcessor extends DevOpsProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {}
    }
    const { dir, project } = writeProject({
      "main.tf":
        'resource "aws_s3_bucket" "logs" {\n  bucket = "my-logs"\n}\n\nresource "aws_iam_role" "app" {\n  name = "app-role"\n}\n',
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);

    const names = p.captured.nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["aws_s3_bucket.logs", "aws_iam_role.app"]));
    cleanup(dir);
  });

  it("walks the file tree generically (inherited from the base)", async () => {
    const { dir, project } = writeProject({
      "Chart.yaml": "name: my-chart\nversion: 1.0.0\n",
      "templates/deployment.yaml": "apiVersion: apps/v1\n",
    });
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("templates");
    expect(names).toContain("Chart.yaml");
    const templates = children.find((c) => c.name === "templates")!;
    expect(templates.type).toBe(ReactorNodeType.FOLDER);
    cleanup(dir);
  });
});
