import ExternalSourcesMacroDefinitions, {
  ListExternalSourcesMacroDefinition,
  RegisterExternalSourceMacroDefinition,
  SyncExternalSourceMacroDefinition,
} from "../ExternalSources.macro";
import { createMockState } from "../../data/__tests__/support/mockState";

const PROJECT_SERVICE = "reactor.ReactorProjectService@1.0.0";

const mockProjectService = (overrides: Record<string, any> = {}) => ({
  listExternalSources: jest.fn().mockResolvedValue([
    {
      _id: "src-1",
      fqn: "jira.worldremit@1.0.0",
      name: "worldremit",
      nameSpace: "jira",
      lastSync: new Date("2026-09-04T00:00:00Z"),
      source: { scheme: "jira", sourceKey: "x.atlassian.net", syncSchedule: "0 * * * *" },
    },
  ]),
  listExternalSchemes: jest.fn().mockReturnValue(["jira", "db"]),
  registerExternalSource: jest.fn().mockImplementation(async (input: any) => ({
    _id: "src-new",
    fqn: `${input.nameSpace}.${input.name}@${input.version || "1.0.0"}`,
    name: input.name,
    nameSpace: input.nameSpace,
    source: {
      scheme: input.scheme,
      sourceKey: input.sourceKey,
      settingKey: input.settingKey,
      options: input.options,
      syncSchedule: input.syncSchedule,
    },
  })),
  enqueueCatalog: jest.fn().mockResolvedValue({ jobId: "job-1" }),
  syncDueExternalSources: jest.fn().mockResolvedValue({
    enqueued: [{ projectId: "src-1", fqn: "jira.worldremit@1.0.0", jobId: "job-due" }],
  }),
  ...overrides,
});

const stateWith = (svc: any) =>
  createMockState({ services: { [PROJECT_SERVICE]: svc } });

describe("external source macros — registration & safety posture", () => {
  it("exports the three macros with the right safety flags", () => {
    expect(ExternalSourcesMacroDefinitions).toHaveLength(3);
    expect(ListExternalSourcesMacroDefinition.tools![0].safeForAutoExecution).toBe(true);
    expect(SyncExternalSourceMacroDefinition.tools![0].safeForAutoExecution).toBe(true);
    // registration always requires human confirmation
    expect(RegisterExternalSourceMacroDefinition.tools![0].safeForAutoExecution).toBe(false);
  });

  it("registration tool never accepts credential parameters", () => {
    const props = RegisterExternalSourceMacroDefinition.tools![0].function.parameters.properties;
    const names = Object.keys(props).map((k) => k.toLowerCase());
    ["password", "token", "apikey", "api_token", "secret", "email"].forEach((banned) =>
      expect(names).not.toContain(banned)
    );
    expect(names).toContain("settingkey"); // the only credential reference allowed
  });
});

describe("listExternalSources", () => {
  it("lists sources with schemes and stores them on state", async () => {
    const svc = mockProjectService();
    const state = stateWith(svc);
    const result: any = await (ListExternalSourcesMacroDefinition.component as any)({}, state);
    expect(result.success).toBe(true);
    expect(result.data.sources).toHaveLength(1);
    expect(result.data.sources[0].scheme).toBe("jira");
    expect(result.data.availableSchemes).toEqual(["jira", "db"]);
    expect(result.instructions).toContain("jira.worldremit@1.0.0");
    expect((state.vars as any).externalSources).toHaveLength(1);
  });

  it("fails gracefully without the service", async () => {
    const result: any = await (ListExternalSourcesMacroDefinition.component as any)(
      {},
      createMockState({ services: {} })
    );
    expect(result.success).toBe(false);
  });
});

describe("registerExternalSource", () => {
  const input = {
    nameSpace: "jira",
    name: "worldremit",
    scheme: "jira",
    sourceKey: "x.atlassian.net",
    settingKey: "atlassian_default",
    options: { projectKeys: ["WR"] },
  };

  it("registers and enqueues the first sync by default", async () => {
    const svc = mockProjectService();
    const result: any = await (RegisterExternalSourceMacroDefinition.component as any)(
      input,
      stateWith(svc)
    );
    expect(result.success).toBe(true);
    expect(svc.registerExternalSource).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "jira", sourceKey: "x.atlassian.net" })
    );
    expect(svc.enqueueCatalog).toHaveBeenCalledWith("src-new", {});
    expect(result.data.jobId).toBe("job-1");
    expect(result.instructions).toContain("jira.worldremit@1.0.0");
  });

  it("honours sync: false and parses stringified options", async () => {
    const svc = mockProjectService();
    const result: any = await (RegisterExternalSourceMacroDefinition.component as any)(
      { ...input, options: '{"projectKeys":["WR"]}', sync: false },
      stateWith(svc)
    );
    expect(result.success).toBe(true);
    expect(svc.enqueueCatalog).not.toHaveBeenCalled();
    expect(svc.registerExternalSource).toHaveBeenCalledWith(
      expect.objectContaining({ options: { projectKeys: ["WR"] } })
    );
  });

  it("returns actionable guidance when the service rejects (bad settingKey etc.)", async () => {
    const svc = mockProjectService({
      registerExternalSource: jest
        .fn()
        .mockRejectedValue(new Error("Setting 'ghost' does not resolve for partner 'p'")),
    });
    const result: any = await (RegisterExternalSourceMacroDefinition.component as any)(
      { ...input, settingKey: "ghost" },
      stateWith(svc)
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("ghost");
    expect(result.instructions).toContain("never pass credentials");
  });

  it("rejects unparseable options strings", async () => {
    const svc = mockProjectService();
    const result: any = await (RegisterExternalSourceMacroDefinition.component as any)(
      { ...input, options: "not json{" },
      stateWith(svc)
    );
    expect(result.success).toBe(false);
    expect(svc.registerExternalSource).not.toHaveBeenCalled();
  });
});

describe("syncExternalSource", () => {
  it("enqueues a targeted sync", async () => {
    const svc = mockProjectService();
    const result: any = await (SyncExternalSourceMacroDefinition.component as any)(
      { idOrFqn: "jira.worldremit@1.0.0" },
      stateWith(svc)
    );
    expect(result.success).toBe(true);
    expect(svc.enqueueCatalog).toHaveBeenCalledWith("jira.worldremit@1.0.0", {});
    expect(result.data.jobId).toBe("job-1");
  });

  it("syncs all due sources when no target is given", async () => {
    const svc = mockProjectService();
    const result: any = await (SyncExternalSourceMacroDefinition.component as any)({}, stateWith(svc));
    expect(result.success).toBe(true);
    expect(svc.syncDueExternalSources).toHaveBeenCalled();
    expect(result.data.enqueued).toHaveLength(1);
  });
});
