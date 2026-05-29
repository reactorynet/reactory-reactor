import { existsSync, readFileSync } from "fs";

jest.mock("fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock("@reactory/server-core/modules", () => ({
  enabled: [],
}));

jest.mock("@reactorynet/reactory-core", () => ({
  FeatureType: { function: "function" },
}));

import { searchSkills, SearchSkillsRegistry } from "../searchSkills.macro";
import { readSkill, ReadSkillRegistry } from "../readSkill.macro";
import SkillsMacros, { readSkill as readSkillExport, searchSkills as searchSkillsExport } from "../index";
import type { ISkillDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

// Minimal ChatState stub — both macros ignore it
const stubState: any = {};

// ── Fixtures ───────────────────────────────────────────────────────────────────

const makeSkill = (overrides: Partial<ISkillDefinition> = {}): ISkillDefinition => ({
  id: "test-module.doTask@1.0.0",
  name: "doTask",
  description: "Performs a specific task in the test module.",
  nameSpace: "test-module",
  version: "1.0.0",
  filePath: "/abs/path/to/doTask.md",
  tags: ["task", "test"],
  roles: [],
  ...overrides,
});

const makeModule = (skills: ISkillDefinition[]) => ({
  id: "test-module",
  nameSpace: "test-module",
  name: "TestModule",
  version: "1.0.0",
  priority: 1,
  reactor: { skills },
});

const makeRuntimeContext = (allowedRoles: string[] = []) =>
  ({
    hasAnyRole: jest.fn((roles: string[]) => roles.some((role) => allowedRoles.includes(role))),
  } as any);

function setModules(modules: object[]) {
  const ReactoryModules = require("@reactory/server-core/modules");
  ReactoryModules.enabled = modules;
}

// ── searchSkills ───────────────────────────────────────────────────────────────

describe("searchSkills", () => {
  beforeEach(() => {
    setModules([]);
    jest.clearAllMocks();
  });

  describe("empty catalog", () => {
    it("returns success with empty array when no modules have skills", async () => {
      const result = await searchSkills({}, stubState);

      expect(result.success).toBe(true);
      expect(result.skills).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hint).toMatch(/No skills are registered/);
    });

    it("returns empty catalog when modules have no reactor property", async () => {
      setModules([{ id: "bare-module", nameSpace: "bare", name: "Bare", version: "1.0.0", priority: 1 }]);
      const result = await searchSkills({}, stubState);

      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(0);
    });

    it("returns empty catalog when reactor has no skills array", async () => {
      setModules([{ id: "m", nameSpace: "m", name: "M", version: "1.0.0", priority: 1, reactor: { macros: [] } }]);
      const result = await searchSkills({}, stubState);

      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(0);
    });
  });

  describe("no filters", () => {
    it("returns all skills when no props are passed", async () => {
      const skill = makeSkill();
      setModules([makeModule([skill])]);

      const result = await searchSkills({}, stubState);

      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.skills).toHaveLength(1);
    });

    it("omits filePath from returned results", async () => {
      setModules([makeModule([makeSkill()])]);
      const result = await searchSkills({}, stubState);

      expect((result.skills![0] as any).filePath).toBeUndefined();
    });

    it("shows readSkill hint when results are found", async () => {
      setModules([makeModule([makeSkill()])]);
      const result = await searchSkills({}, stubState);

      expect(result.hint).toMatch(/@readSkill/);
    });
  });

  describe("query filtering", () => {
    const skillA = makeSkill({ id: "m.alpha@1.0.0", name: "alpha", description: "Alpha description", nameSpace: "m", tags: ["alpha-tag"] });
    const skillB = makeSkill({ id: "m.beta@1.0.0", name: "beta", description: "Beta description", nameSpace: "m", tags: ["beta-tag"] });

    beforeEach(() => setModules([makeModule([skillA, skillB])]));

    it("matches on skill name", async () => {
      const result = await searchSkills({ query: "alpha" }, stubState);
      expect(result.skills!.map((s) => s.name)).toEqual(["alpha"]);
    });

    it("matches on description", async () => {
      const result = await searchSkills({ query: "beta description" }, stubState);
      expect(result.skills!.map((s) => s.name)).toEqual(["beta"]);
    });

    it("matches on tags", async () => {
      const result = await searchSkills({ query: "alpha-tag" }, stubState);
      expect(result.skills!.map((s) => s.name)).toEqual(["alpha"]);
    });

    it("matches on nameSpace", async () => {
      const skillC = makeSkill({ id: "other.gamma@1.0.0", name: "gamma", description: "Gamma", nameSpace: "other", tags: [] });
      setModules([makeModule([skillA, skillB]), makeModule([skillC])]);

      const result = await searchSkills({ query: "other" }, stubState);
      expect(result.skills!.map((s) => s.name)).toContain("gamma");
    });

    it("is case-insensitive", async () => {
      const result = await searchSkills({ query: "ALPHA" }, stubState);
      expect(result.skills!).toHaveLength(1);
    });

    it("returns empty + no-match hint when nothing matches", async () => {
      const result = await searchSkills({ query: "zzznomatch" }, stubState);
      expect(result.skills).toHaveLength(0);
      expect(result.hint).toMatch(/No skills matched/);
    });
  });

  describe("tags filter", () => {
    const skillA = makeSkill({ id: "m.a@1.0.0", name: "a", nameSpace: "m", tags: ["crud", "article"] });
    const skillB = makeSkill({ id: "m.b@1.0.0", name: "b", nameSpace: "m", tags: ["auth"] });
    const skillC = makeSkill({ id: "m.c@1.0.0", name: "c", nameSpace: "m", tags: ["crud", "user"] });

    beforeEach(() => setModules([makeModule([skillA, skillB, skillC])]));

    it("returns skills that have any of the specified tags (OR logic)", async () => {
      const result = await searchSkills({ tags: ["crud"] }, stubState);
      const names = result.skills!.map((s) => s.name);
      expect(names).toContain("a");
      expect(names).toContain("c");
      expect(names).not.toContain("b");
    });

    it("returns nothing when no skill has the tag", async () => {
      const result = await searchSkills({ tags: ["zzznomatch"] }, stubState);
      expect(result.skills).toHaveLength(0);
    });

    it("tag matching is case-insensitive", async () => {
      const result = await searchSkills({ tags: ["CRUD"] }, stubState);
      expect(result.skills!).toHaveLength(2);
    });
  });

  describe("nameSpace filter", () => {
    const skillA = makeSkill({ id: "mod-a.x@1.0.0", name: "x", nameSpace: "mod-a", tags: [] });
    const skillB = makeSkill({ id: "mod-b.y@1.0.0", name: "y", nameSpace: "mod-b", tags: [] });

    beforeEach(() => setModules([makeModule([skillA, skillB])]));

    it("returns only skills from the specified nameSpace", async () => {
      const result = await searchSkills({ nameSpace: "mod-a" }, stubState);
      expect(result.skills!.map((s) => s.name)).toEqual(["x"]);
    });

    it("is case-insensitive", async () => {
      const result = await searchSkills({ nameSpace: "MOD-B" }, stubState);
      expect(result.skills!.map((s) => s.name)).toEqual(["y"]);
    });
  });

  describe("limit", () => {
    it("truncates results to the specified limit", async () => {
      const skills = Array.from({ length: 10 }, (_, i) =>
        makeSkill({ id: `m.skill${i}@1.0.0`, name: `skill${i}`, nameSpace: "m", tags: [] })
      );
      setModules([makeModule(skills)]);

      const result = await searchSkills({ limit: 3 }, stubState);
      expect(result.skills).toHaveLength(3);
    });

    it("defaults to 20 when limit is not specified", async () => {
      const skills = Array.from({ length: 25 }, (_, i) =>
        makeSkill({ id: `m.skill${i}@1.0.0`, name: `skill${i}`, nameSpace: "m", tags: [] })
      );
      setModules([makeModule(skills)]);

      const result = await searchSkills({}, stubState);
      expect(result.skills).toHaveLength(20);
    });
  });

  describe("deduplication", () => {
    it("last module wins for duplicate skill ids", async () => {
      const first = makeSkill({ id: "m.shared@1.0.0", description: "First version" });
      const second = makeSkill({ id: "m.shared@1.0.0", description: "Second version" });

      setModules([makeModule([first]), makeModule([second])]);

      const result = await searchSkills({}, stubState);
      expect(result.total).toBe(1);
      expect(result.skills![0].description).toBe("Second version");
    });
  });

  describe("role checks", () => {
    it("returns skills without roles even when no runtime roles are available", async () => {
      const unrestricted = makeSkill({
        id: "mod.public@1.0.0",
        name: "publicSkill",
        roles: [],
      });
      setModules([makeModule([unrestricted])]);

      const result = await searchSkills({}, stubState);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(1);
    });

    it("filters out protected skills when context denies role access", async () => {
      const protectedSkill = makeSkill({
        id: "mod.admin@1.0.0",
        name: "adminSkill",
        roles: ["ADMIN"],
      });
      setModules([makeModule([protectedSkill])]);

      const runtimeContext = makeRuntimeContext(["USER"]);
      const result = await searchSkills({}, stubState, runtimeContext);

      expect(runtimeContext.hasAnyRole).toHaveBeenCalledWith(["ADMIN"]);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(0);
    });

    it("returns protected skills when context grants role access", async () => {
      const protectedSkill = makeSkill({
        id: "mod.admin@1.0.0",
        name: "adminSkill",
        roles: ["ADMIN"],
      });
      setModules([makeModule([protectedSkill])]);

      const runtimeContext = makeRuntimeContext(["ADMIN"]);
      const result = await searchSkills({}, stubState, runtimeContext);

      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(1);
      expect(result.skills![0].id).toBe("mod.admin@1.0.0");
    });

    it("falls back to state.user roles when context role helper is unavailable", async () => {
      const protectedSkill = makeSkill({
        id: "mod.editor@1.0.0",
        name: "editorSkill",
        roles: ["EDITOR"],
      });
      setModules([makeModule([protectedSkill])]);

      const stateWithRoles = {
        ...stubState,
        user: {
          activeMembership: {
            roles: ["EDITOR"],
          },
        },
      } as any;

      const result = await searchSkills({}, stateWithRoles);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(1);
    });

    it("treats blank role entries as unrestricted", async () => {
      const malformedRolesSkill = makeSkill({
        id: "mod.malformed@1.0.0",
        name: "malformedRoles",
        roles: ["", "   "],
      });
      setModules([makeModule([malformedRolesSkill])]);

      const result = await searchSkills({}, stubState);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(1);
    });

    it("falls back to user.roles when activeMembership is missing", async () => {
      const protectedSkill = makeSkill({
        id: "mod.auditor@1.0.0",
        name: "auditorSkill",
        roles: ["AUDITOR"],
      });
      setModules([makeModule([protectedSkill])]);

      const stateWithDirectRoles = {
        ...stubState,
        user: {
          roles: ["AUDITOR"],
        },
      } as any;

      const result = await searchSkills({}, stateWithDirectRoles);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(1);
    });

    it("denies protected skills when no role helper and no user roles are present", async () => {
      const protectedSkill = makeSkill({
        id: "mod.protected@1.0.0",
        name: "protectedSkill",
        roles: ["ADMIN"],
      });
      setModules([makeModule([protectedSkill])]);

      const result = await searchSkills({}, { ...stubState, user: {} } as any);
      expect(result.success).toBe(true);
      expect(result.skills).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("returns { success: false, error } when an unexpected error is thrown", async () => {
      const ReactoryModules = require("@reactory/server-core/modules");
      Object.defineProperty(ReactoryModules, "enabled", {
        get() { throw new Error("unexpected failure"); },
        configurable: true,
      });

      const result = await searchSkills({}, stubState);
      expect(result.success).toBe(false);
      expect(result.error).toBe("unexpected failure");

      // Restore
      Object.defineProperty(ReactoryModules, "enabled", {
        value: [],
        writable: true,
        configurable: true,
      });
    });
  });

  describe("registry shape", () => {
    it("has correct nameSpace, name, version", () => {
      expect(SearchSkillsRegistry.nameSpace).toBe("reactor-macros");
      expect(SearchSkillsRegistry.name).toBe("searchSkills");
      expect(SearchSkillsRegistry.version).toBe("1.0.0");
    });

    it("exposes a function tool named searchSkills", () => {
      const tool = SearchSkillsRegistry.tools![0];
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe("searchSkills");
    });

    it("marks tool as safe for auto execution", () => {
      expect(SearchSkillsRegistry.tools![0].safeForAutoExecution).toBe(true);
    });

    it("component points to the searchSkills function", () => {
      expect(SearchSkillsRegistry.component).toBe(searchSkills);
    });
  });
});

// ── readSkill ──────────────────────────────────────────────────────────────────

describe("readSkill", () => {
  const skill = makeSkill();

  beforeEach(() => {
    setModules([]);
    jest.clearAllMocks();
  });

  describe("validation", () => {
    it("returns error when neither id nor name is provided", async () => {
      const result = await readSkill({}, stubState);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Either id or name is required/);
    });
  });

  describe("lookup by id", () => {
    it("returns skill content when found by id and file exists", async () => {
      setModules([makeModule([skill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("# Skill content" as any);

      const result = await readSkill({ id: skill.id }, stubState);

      expect(result.success).toBe(true);
      expect(result.id).toBe(skill.id);
      expect(result.name).toBe(skill.name);
      expect(result.nameSpace).toBe(skill.nameSpace);
      expect(result.version).toBe(skill.version);
      expect(result.description).toBe(skill.description);
      expect(result.tags).toEqual(skill.tags);
      expect(result.content).toBe("# Skill content");
    });

    it("returns error when id does not match any skill", async () => {
      setModules([makeModule([skill])]);

      const result = await readSkill({ id: "nonexistent.skill@1.0.0" }, stubState);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/nonexistent\.skill@1\.0\.0/);
      expect(result.error).toMatch(/@searchSkills/);
    });

    it("returns error when skill file does not exist on disk", async () => {
      setModules([makeModule([skill])]);
      mockExistsSync.mockReturnValue(false);

      const result = await readSkill({ id: skill.id }, stubState);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Skill file not found/);
      expect(result.error).toContain(skill.filePath);
    });

    it("reads file with utf-8 encoding", async () => {
      setModules([makeModule([skill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("content" as any);

      await readSkill({ id: skill.id }, stubState);
      expect(mockReadFileSync).toHaveBeenCalledWith(skill.filePath, "utf-8");
    });

    it("returns access denied when context does not have required role", async () => {
      const protectedSkill = makeSkill({ roles: ["ADMIN"] });
      setModules([makeModule([protectedSkill])]);

      const runtimeContext = makeRuntimeContext(["USER"]);
      const result = await readSkill({ id: protectedSkill.id }, stubState, runtimeContext);

      expect(runtimeContext.hasAnyRole).toHaveBeenCalledWith(["ADMIN"]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Access denied/);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("allows access when context has required role", async () => {
      const protectedSkill = makeSkill({ roles: ["ADMIN"] });
      setModules([makeModule([protectedSkill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("# protected" as any);

      const runtimeContext = makeRuntimeContext(["ADMIN"]);
      const result = await readSkill({ id: protectedSkill.id }, stubState, runtimeContext);

      expect(result.success).toBe(true);
      expect(result.content).toBe("# protected");
    });

    it("falls back to state.user roles when context helper is unavailable", async () => {
      const protectedSkill = makeSkill({ roles: ["SUPPORT"] });
      setModules([makeModule([protectedSkill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("# support" as any);

      const stateWithRoles = {
        ...stubState,
        user: {
          memberships: [{ roles: ["SUPPORT"] }],
        },
      } as any;

      const result = await readSkill({ id: protectedSkill.id }, stateWithRoles);
      expect(result.success).toBe(true);
      expect(result.content).toBe("# support");
    });
  });

  describe("lookup by name", () => {
    it("returns skill when found by name without nameSpace constraint", async () => {
      setModules([makeModule([skill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("content" as any);

      const result = await readSkill({ name: skill.name }, stubState);
      expect(result.success).toBe(true);
      expect(result.name).toBe(skill.name);
    });

    it("returns skill when found by name + matching nameSpace", async () => {
      setModules([makeModule([skill])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("content" as any);

      const result = await readSkill({ name: skill.name, nameSpace: skill.nameSpace }, stubState);
      expect(result.success).toBe(true);
    });

    it("does not match when nameSpace differs", async () => {
      setModules([makeModule([skill])]);

      const result = await readSkill({ name: skill.name, nameSpace: "wrong-namespace" }, stubState);
      expect(result.success).toBe(false);
    });

    it("builds identifier as nameSpace.name when nameSpace is provided", async () => {
      setModules([makeModule([skill])]);

      const result = await readSkill({ name: "unknown", nameSpace: "my-module" }, stubState);
      expect(result.error).toContain("my-module.unknown");
    });

    it("builds identifier as plain name when nameSpace is absent", async () => {
      setModules([makeModule([skill])]);

      const result = await readSkill({ name: "unknown" }, stubState);
      expect(result.error).toContain('"unknown"');
      // identifier should not be prefixed with a namespace dot
      expect(result.error).not.toContain('."unknown"');
    });
  });

  describe("id takes priority over name", () => {
    it("resolves by id when both id and name are provided", async () => {
      const skillById = makeSkill({ id: "m.byId@1.0.0", name: "byId" });
      const skillByName = makeSkill({ id: "m.byName@1.0.0", name: "byName" });
      setModules([makeModule([skillById, skillByName])]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("content" as any);

      const result = await readSkill({ id: "m.byId@1.0.0", name: "byName" }, stubState);
      expect(result.name).toBe("byId");
    });
  });

  describe("modules without skills", () => {
    it("skips modules with no reactor property", async () => {
      setModules([{ id: "bare", nameSpace: "bare", name: "Bare", version: "1.0.0", priority: 1 }]);

      const result = await readSkill({ id: skill.id }, stubState);
      expect(result.success).toBe(false);
    });

    it("skips modules where reactor.skills is empty", async () => {
      setModules([{ ...makeModule([skill]), reactor: { skills: [] } }]);

      const result = await readSkill({ id: skill.id }, stubState);
      expect(result.success).toBe(false);
    });
  });

  describe("registry shape", () => {
    it("has correct nameSpace, name, version", () => {
      expect(ReadSkillRegistry.nameSpace).toBe("reactor-macros");
      expect(ReadSkillRegistry.name).toBe("readSkill");
      expect(ReadSkillRegistry.version).toBe("1.0.0");
    });

    it("exposes a function tool named readSkill", () => {
      const tool = ReadSkillRegistry.tools![0];
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe("readSkill");
    });

    it("marks tool as safe for auto execution", () => {
      expect(ReadSkillRegistry.tools![0].safeForAutoExecution).toBe(true);
    });

    it("component points to the readSkill function", () => {
      expect(ReadSkillRegistry.component).toBe(readSkill);
    });
  });
});

describe("skills index", () => {
  it("re-exports both macros and the default registry array", () => {
    expect(searchSkillsExport).toBe(searchSkills);
    expect(readSkillExport).toBe(readSkill);
    expect(SkillsMacros).toEqual([SearchSkillsRegistry, ReadSkillRegistry]);
  });
});
