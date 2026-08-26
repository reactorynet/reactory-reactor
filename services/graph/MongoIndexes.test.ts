import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";
import { ReactorProjectModel } from "../../models/ReactorProject";

describe("Session 07 — Mongo Indexes & First-Class Project Fields", () => {
  describe("reactor_nodes indexes", () => {
    it("declares all required compound and single indexes", () => {
      const indexes = ReactorNodeModel.schema.indexes();
      const indexKeys = indexes.map(([fields]) => fields);

      // Check compound indexes
      expect(indexKeys).toContainEqual({ projectId: 1, runId: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1, parentId: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1, type: 1 });
      expect(indexKeys).toContainEqual({ type: 1, name: 1 });
      expect(indexKeys).toContainEqual({ projectFqn: 1, type: 1 });

      // Check field-level indexes
      expect(indexKeys).toContainEqual({ id: 1 });
      expect(indexKeys).toContainEqual({ key: 1 });
      expect(indexKeys).toContainEqual({ providerId: 1 });
      expect(indexKeys).toContainEqual({ parentId: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1 });
      expect(indexKeys).toContainEqual({ projectFqn: 1 });
      expect(indexKeys).toContainEqual({ runId: 1 });
      expect(indexKeys).toContainEqual({ indexedAt: 1 });
    });
  });

  describe("reactor_node_links indexes", () => {
    it("declares all required compound and single indexes", () => {
      const indexes = ReactorNodeLinkModel.schema.indexes();
      const indexKeys = indexes.map(([fields]) => fields);

      // Check compound indexes
      expect(indexKeys).toContainEqual({ source: 1, target: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1, runId: 1 });
      expect(indexKeys).toContainEqual({ source: 1, types: 1 });
      expect(indexKeys).toContainEqual({ target: 1, types: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1, source: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1, target: 1 });

      // Check field-level indexes
      expect(indexKeys).toContainEqual({ id: 1 });
      expect(indexKeys).toContainEqual({ source: 1 });
      expect(indexKeys).toContainEqual({ target: 1 });
      expect(indexKeys).toContainEqual({ projectId: 1 });
      expect(indexKeys).toContainEqual({ runId: 1 });
      expect(indexKeys).toContainEqual({ indexedAt: 1 });
    });
  });

  describe("reactor_projects indexes", () => {
    it("declares unique sparse index on graphRootId", () => {
      const indexes = ReactorProjectModel.schema.indexes();
      const graphRootIndex = indexes.find(([fields]) => fields.graphRootId === 1);

      expect(graphRootIndex).toBeDefined();
      const [fields, options] = graphRootIndex!;
      expect(fields).toEqual({ graphRootId: 1 });
      expect(options?.unique).toBe(true);
      expect(options?.sparse).toBe(true);
    });
  });
});
