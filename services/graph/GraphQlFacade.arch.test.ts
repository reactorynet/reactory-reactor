import fs from "fs";
import path from "path";

describe("Session 15 — GraphQL Façade Architecture Invariant", () => {
  it("ReactorSystemGraph resolver does not import or directly reference ReactorNodeModel or ReactorNodeLinkModel", () => {
    const resolverPath = path.resolve(
      __dirname,
      "../../graphql/resolvers/ReactorSystemGraph.ts"
    );
    const src = fs.readFileSync(resolverPath, "utf8");

    // Must not import or reference ReactorNodeModel or ReactorNodeLinkModel
    expect(src).not.toMatch(/ReactorNodeModel/);
    expect(src).not.toMatch(/ReactorNodeLinkModel/);
  });
});
