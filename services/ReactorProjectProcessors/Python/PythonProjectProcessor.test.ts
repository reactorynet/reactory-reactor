import PythonProjectProcessor from "./PythonProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("PythonProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new PythonProjectProcessor({}, ctx);

  it("detects python projects via requirements/setup/pyproject", () => {
    const req = writeProject({ "requirements.txt": "flask\n" });
    expect(processor.supportsProject(req.project)).toBe(true);
    expect(processor.getProjectTypes(req.project)).toEqual(["python"]);
    cleanup(req.dir);

    const pyproject = writeProject({ "pyproject.toml": "[project]\nname='x'" });
    expect(processor.supportsProject(pyproject.project)).toBe(true);
    cleanup(pyproject.dir);

    const foreign = writeProject({ "pom.xml": "<project/>" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    cleanup(foreign.dir);
  });

  it("process() assembles symbols and edges from python sources", async () => {
    // Capture what would be persisted/indexed, without Mongo.
    class CapturingProcessor extends PythonProjectProcessor {
      public captured: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
      protected async persistGraph(nodes: any[], edges: any[]) {
        this.captured = { nodes, edges };
      }
      protected async indexSearchables() {
        /* skip search indexing in tests */
      }
    }
    const { dir, project } = writeProject({
      "requirements.txt": "flask\n",
      "app/base.py": "class Base:\n    def go(self):\n        return 1\n",
      "app/svc.py": "from .base import Base\n\nclass Svc(Base):\n    def run(self):\n        return self.go()\n",
    });
    const p = new CapturingProcessor({}, makeContext());
    await p.process(project);
    const names = p.captured.nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["Base", "Svc", "run", "go"]));
    // an INHERITS edge (Svc -> Base) should have been produced
    expect(p.captured.edges.some((e) => e.types?.includes("INHERITS"))).toBe(true);
    cleanup(dir);
  });

  it("walks the file tree generically (inherited from the base)", async () => {
    const { dir, project } = writeProject({
      "requirements.txt": "flask\n",
      "app/main.py": "def run():\n    return 1\n",
    });
    const root = await processor.getProjectNode(project);
    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("app");
    expect(names).toContain("requirements.txt");
    const app = children.find((c) => c.name === "app")!;
    expect(app.type).toBe(ReactorNodeType.FOLDER);
    const appChildren = await processor.getChildrenForNode(app as any, app.key, null, null);
    expect(appChildren.map((c) => c.name)).toContain("main.py");
    cleanup(dir);
  });
});
