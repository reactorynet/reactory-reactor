import SystemGraphManager from "../SystemGraphManager";
import ReactorProjectServiceImpl from "../ReactorProjectService";
import { ReactorProjectModel } from "../../models/ReactorProject";
import { ReactorNodeModel } from "../../models/ReactorGraphNode";
import { ReactorNodeLinkModel } from "../../models/ReactorNodeLink";
import { nodeId, projectLogicalKey, linkId } from "./GraphIdentity";
import { ReactorNodeType, ReactorLinkType, ReactorNode } from "../../types/model.types";
import { IReactorProject } from "../../types/service.types";

const makeContext = (overrides: Record<string, any> = {}) => {
  const store = new Map<string, any>();
  const services = new Map<string, any>();

  const ctx: any = {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    getService: (id: string) => services.get(id) || null,
    setService: (id: string, instance: any) => services.set(id, instance),
    utils: {
      hash: (val: any) => nodeId(String(val)),
    },
    __store: store,
    ...overrides,
  };
  return ctx;
};

describe("Session 12 — Cross-Project External Dependency Linking", () => {
  let ctx: any;
  let manager: SystemGraphManager;

  const projectA: Partial<IReactorProject> = {
    id: "proj-a",
    name: "app-client",
    nameSpace: "reactor",
    version: "1.0.0",
    repoPath: "/path/to/app-client",
    graphRootId: nodeId("reactor.app-client@1.0.0"),
  };

  const projectB: Partial<IReactorProject> = {
    id: "proj-b",
    name: "foo-lib",
    nameSpace: "reactor",
    version: "1.0.0",
    repoPath: "/path/to/foo-lib",
    graphRootId: nodeId("reactor.foo-lib@1.0.0"),
    publishedPackages: ["foo-lib", "@scope/foo-helper"],
  };

  const externalFooLibNode: Partial<ReactorNode> = {
    id: nodeId("npm:foo-lib"),
    name: "foo-lib",
    type: ReactorNodeType.DEPENDENCY,
    parentId: projectA.graphRootId,
    projectId: "proj-a",
    data: {
      kind: "external",
      package: "foo-lib",
      projectId: "proj-a",
    },
  };

  const externalFooHelperNode: Partial<ReactorNode> = {
    id: nodeId("npm:@scope/foo-helper"),
    name: "@scope/foo-helper",
    type: ReactorNodeType.DEPENDENCY,
    parentId: projectA.graphRootId,
    projectId: "proj-a",
    data: {
      kind: "external",
      package: "@scope/foo-helper",
      projectId: "proj-a",
    },
  };

  const externalMissingNode: Partial<ReactorNode> = {
    id: nodeId("npm:unregistered-dep"),
    name: "unregistered-dep",
    type: ReactorNodeType.DEPENDENCY,
    parentId: projectA.graphRootId,
    projectId: "proj-a",
    data: {
      kind: "external",
      package: "unregistered-dep",
      projectId: "proj-a",
    },
  };

  beforeEach(() => {
    ctx = makeContext();
    manager = new SystemGraphManager({}, ctx);
    jest.restoreAllMocks();
  });

  it("links external dependency node to publisher project root when matched", async () => {
    const projects = [projectA, projectB];
    const externals = [externalFooLibNode, externalFooHelperNode, externalMissingNode];

    jest.spyOn(ReactorProjectModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue(projects),
    } as any);

    jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue(externals),
    } as any);

    const bulkWriteSpy = jest.spyOn(ReactorNodeLinkModel, "bulkWrite").mockResolvedValue({} as any);

    const result = await manager.linkExternalProjects("proj-a");

    expect(result.totalExternals).toBe(3);
    expect(result.createdLinks).toBe(2); // foo-lib and @scope/foo-helper matched; unregistered-dep did not
    expect(bulkWriteSpy).toHaveBeenCalledTimes(1);

    const ops = bulkWriteSpy.mock.calls[0][0];
    expect(ops.length).toBe(2);

    // foo-lib link
    const fooLibLinkOp = ops.find((op: any) => op.updateOne.filter.id === linkId(externalFooLibNode.id!, projectB.graphRootId!, ReactorLinkType.REFERENCE));
    expect(fooLibLinkOp).toBeDefined();
    expect(fooLibLinkOp.updateOne.update.$set.source).toBe(externalFooLibNode.id);
    expect(fooLibLinkOp.updateOne.update.$set.target).toBe(projectB.graphRootId);
    expect(fooLibLinkOp.updateOne.update.$set.types).toContain(ReactorLinkType.REFERENCE);
    expect(fooLibLinkOp.updateOne.update.$set.types).toContain(ReactorLinkType.DEPENDENCY);
    expect(fooLibLinkOp.updateOne.update.$set.data.crossProject).toBe(true);

    // @scope/foo-helper link
    const fooHelperLinkOp = ops.find((op: any) => op.updateOne.filter.id === linkId(externalFooHelperNode.id!, projectB.graphRootId!, ReactorLinkType.REFERENCE));
    expect(fooHelperLinkOp).toBeDefined();
    expect(fooHelperLinkOp.updateOne.update.$set.target).toBe(projectB.graphRootId);
  });

  it("does not create self-link if publisher is the same project", async () => {
    const selfExternalNode: Partial<ReactorNode> = {
      id: nodeId("npm:foo-lib"),
      name: "foo-lib",
      type: ReactorNodeType.DEPENDENCY,
      parentId: projectB.graphRootId,
      projectId: "proj-b",
      data: {
        kind: "external",
        package: "foo-lib",
        projectId: "proj-b",
      },
    };

    jest.spyOn(ReactorProjectModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([projectB]),
    } as any);

    jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([selfExternalNode]),
    } as any);

    const bulkWriteSpy = jest.spyOn(ReactorNodeLinkModel, "bulkWrite").mockResolvedValue({} as any);

    const result = await manager.linkExternalProjects("proj-b");
    expect(result.createdLinks).toBe(0);
    expect(bulkWriteSpy).not.toHaveBeenCalled();
  });

  it("does not emit edge for missing publisher (Invariant I4)", async () => {
    jest.spyOn(ReactorProjectModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([projectA]),
    } as any);

    jest.spyOn(ReactorNodeModel, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([externalMissingNode]),
    } as any);

    const bulkWriteSpy = jest.spyOn(ReactorNodeLinkModel, "bulkWrite").mockResolvedValue({} as any);

    const result = await manager.linkExternalProjects("proj-a");
    expect(result.createdLinks).toBe(0);
    expect(bulkWriteSpy).not.toHaveBeenCalled();
  });

  it("is idempotent via deterministic linkId", async () => {
    const expectedLinkId = linkId(externalFooLibNode.id!, projectB.graphRootId!, ReactorLinkType.REFERENCE);
    expect(typeof expectedLinkId).toBe("number");
    expect(expectedLinkId).toBe(linkId(externalFooLibNode.id!, projectB.graphRootId!, ReactorLinkType.REFERENCE));
  });

  describe("ReactorProjectService.getPublishedPackagesIndex", () => {
    let projectService: any;

    beforeEach(() => {
      projectService = new ReactorProjectServiceImpl({}, ctx);
    });

    it("builds index from project name, publishedPackages array, and package.json", async () => {
      jest.spyOn(projectService, "getProjects").mockResolvedValue({
        projects: [projectA, projectB],
        paging: { total: 2, page: 1, pageSize: 5000, hasNext: false },
      });

      const index = await projectService.getPublishedPackagesIndex();

      expect(index.has("app-client")).toBe(true);
      expect(index.get("app-client")!.projectId).toBe("proj-a");
      expect(index.has("foo-lib")).toBe(true);
      expect(index.get("foo-lib")!.projectId).toBe("proj-b");
      expect(index.has("@scope/foo-helper")).toBe(true);
      expect(index.get("@scope/foo-helper")!.projectId).toBe("proj-b");
    });
  });
});
