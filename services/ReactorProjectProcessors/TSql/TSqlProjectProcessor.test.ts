import TSqlProjectProcessor from "./TSqlProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";
import { ReactorNodeType } from "../../../types/model.types";

describe("TSqlProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new TSqlProjectProcessor({}, ctx);

  it("detects .sqlproj / .dacpac database projects", () => {
    const proj = writeProject({ "db.sqlproj": "<Project/>" });
    expect(processor.supportsProject(proj.project)).toBe(true);
    expect(processor.getProjectTypes(proj.project)).toEqual(["tsql"]);
    cleanup(proj.dir);

    const foreign = writeProject({ "package.json": "{}" });
    expect(processor.supportsProject(foreign.project)).toBe(false);
    cleanup(foreign.dir);
  });

  it("roots the datastore and surfaces a Connections node + folders", async () => {
    const { dir, project } = writeProject({
      "db.sqlproj": "<Project/>",
      "Tables/Customer.sql": "CREATE TABLE Customer (Id int);",
    });
    const root = await processor.getProjectNode(project);
    expect(root.type).toBe(ReactorNodeType.DATASTORE);

    const children = await processor.getChildrenForNode(root as any, root.key, null, null);
    const names = children.map((c) => c.name);
    expect(names).toContain("Tables");
    expect(names).toContain("db.sqlproj");
    expect(names).toContain("Connections");
    const connections = children.find((c) => c.name === "Connections")!;
    expect(connections.type).toBe(ReactorNodeType.CONNECTION);
    cleanup(dir);
  });
});
