import fs from "fs";
import path from "path";
import { parse, EnumTypeDefinitionNode } from "graphql";
import { ReactorNodeType, ReactorLinkType } from "../../types/model.types";

/**
 * Guards the three-way vocabulary parity introduced in Providers Session 02:
 * the TS enums (types/model.types.ts) and the GraphQL enums
 * (graphql/schema/ReactorSystemGraph/types.graphql) must stay identical.
 * (The client's styling maps are compiler-enforced against its type unions -
 * a Record<GraphNodeType, ...> with a missing member fails the client build.)
 */
describe("Providers Session 02 — graph vocabulary parity", () => {
  const schemaPath = path.join(
    __dirname,
    "../../graphql/schema/ReactorSystemGraph/types.graphql"
  );
  const doc = parse(fs.readFileSync(schemaPath, "utf8"));

  const enumValues = (name: string): string[] => {
    const def = doc.definitions.find(
      (d): d is EnumTypeDefinitionNode =>
        d.kind === "EnumTypeDefinition" && d.name.value === name
    );
    if (!def) throw new Error(`enum ${name} not found in types.graphql`);
    return (def.values || []).map((v) => v.name.value);
  };

  it("ReactorNodeType GraphQL enum mirrors the TS enum exactly", () => {
    expect(enumValues("ReactorNodeType").sort()).toEqual(
      Object.values(ReactorNodeType).sort()
    );
  });

  it("ReactorLinkType GraphQL enum mirrors the TS enum exactly", () => {
    expect(enumValues("ReactorLinkType").sort()).toEqual(
      Object.values(ReactorLinkType).sort()
    );
  });

  it("session-02 external vocabulary is present in both enums", () => {
    const nodeMembers = Object.values(ReactorNodeType) as string[];
    ["TICKET", "BOARD", "SPRINT", "PERSON", "SCHEMA", "TABLE", "VIEW", "COLUMN", "PROCEDURE"].forEach(
      (m) => expect(nodeMembers).toContain(m)
    );
    const linkMembers = Object.values(ReactorLinkType) as string[];
    ["BLOCKS", "DUPLICATES", "RELATES", "PART_OF", "ASSIGNED_TO", "FOREIGN_KEY"].forEach(
      (m) => expect(linkMembers).toContain(m)
    );
  });
});
