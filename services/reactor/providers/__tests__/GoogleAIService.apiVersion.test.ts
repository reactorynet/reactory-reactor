import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `initializeClient()` must forward the configured Google API version.
 *
 * Why this file exists: `@google/genai` 3.x defaults to `v1` where 1.x defaulted to
 * `v1beta`. The provider used to construct the client with `{ apiKey, vertexai }`
 * only, so upgrading the SDK moved every request to a different endpoint version
 * with no compile error and no exception — the affected models simply stopped
 * resolving. These tests pin the value the constructor receives, and where it came
 * from, so that regression cannot return silently.
 *
 * The SDK is replaced by a stub that records its constructor options; everything else
 * (config loading, version resolution, error handling) is the real code.
 */

jest.mock("@google/genai", () => {
  const constructorCalls: any[] = [];
  const modelsGet = jest.fn(async ({ model }: { model: string }) => ({
    name: `models/${model}`,
    displayName: model,
  }));
  class GoogleGenAI {
    models = { get: modelsGet };
    chats = { create: jest.fn(async () => ({})) };
    constructor(options: any) {
      constructorCalls.push(options);
    }
  }
  // The provider calls `new GoogleGenAI.GoogleGenAI(...)` on its default import, so the
  // stub has to carry itself the same way the real bundle does.
  (GoogleGenAI as any).GoogleGenAI = GoogleGenAI;

  // The factory runs before this file's module body, so the recorder is published on
  // globalThis rather than captured from a `const` that does not exist yet.
  (globalThis as any).__genaiRecorder = { constructorCalls, modelsGet };

  return {
    __esModule: true,
    default: GoogleGenAI,
    GoogleGenAI,
    Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
    Type: {},
    FunctionCallingConfigMode: {},
    FunctionDeclaration: {},
    FunctionResponse: {},
  };
});

const mockContext: any = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  getService: jest.fn(),
};

let GoogleAIService: any;
let constructorCalls: any[];
let modelsGet: jest.Mock<any>;
let originalHome: string | undefined;
let emptyHome: string;

beforeAll(async () => {
  const mod = await import("../GoogleAIService");
  GoogleAIService = mod.default;

  const recorder = (globalThis as any).__genaiRecorder;
  expect(recorder).toBeDefined();
  constructorCalls = recorder.constructorCalls;
  modelsGet = recorder.modelsGet;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.GOOGLE_AI_API_VERSION;
  try {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  constructorCalls.length = 0;
  delete process.env.GOOGLE_AI_API_VERSION;

  // `loadProviders()` overlays `${HOME}/.reactor/providers.yaml`; point HOME at an
  // empty directory so the assertion is about the checked-in providers.yaml and not
  // whatever the developer happens to have in their home directory.
  originalHome = process.env.HOME;
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "genai-api-version-"));
  process.env.HOME = emptyHome;

  jest.clearAllMocks();
});

const persona = (overrides: Record<string, any> = {}): any => ({
  id: "persona-1",
  nameSpace: "reactor",
  name: "Test",
  version: "1.0.0",
  providerId: "google",
  modelId: "gemini-3.8-flash",
  persona: "",
  features: "",
  config: { apiKey: "test-key" },
  ...overrides,
});

const newService = (providerService?: any) => {
  const svc: any = new GoogleAIService({ apiKey: "test-key" }, mockContext);
  if (providerService) svc.providerService = providerService;
  return svc;
};

describe("GoogleAIService.initializeClient — apiVersion forwarding", () => {
  it("forwards the apiVersion declared in providers.yaml", async () => {
    const svc = newService();
    await svc.initializeClient(persona());

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({
      apiKey: "test-key",
      vertexai: false,
      apiVersion: "v1beta",
    });
    // The value that reached the SDK is also observable on the service.
    expect(svc.apiVersion).toBe("v1beta");
  });

  it("never constructs the client without an apiVersion", async () => {
    const svc = newService();
    await svc.initializeClient(persona());

    // The regression was an absent key, so assert presence rather than just shape:
    // an undefined key is dropped by JSON serialisation and by the SDK's own default
    // handling, which is exactly how it failed silently before.
    expect(Object.prototype.hasOwnProperty.call(constructorCalls[0], "apiVersion")).toBe(true);
    expect(constructorCalls[0].apiVersion).toBeTruthy();
    expect(constructorCalls[0].apiVersion).not.toBe("");
    expect(modelsGet).toHaveBeenCalledWith({ model: "gemini-3.8-flash" });
  });

  it("lets GOOGLE_AI_API_VERSION override the configured value", async () => {
    process.env.GOOGLE_AI_API_VERSION = "v1";
    const svc = newService();
    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v1");
    expect(svc.apiVersion).toBe("v1");
  });

  it("trims a padded override instead of forwarding it verbatim", async () => {
    process.env.GOOGLE_AI_API_VERSION = "  v1beta  ";
    const svc = newService();
    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("falls back to the registry apiVersion when the config file cannot supply one", async () => {
    // Simulate a deployment whose providers.yaml has no google entry: the registry
    // record is the only remaining source before the code default.
    const svc = newService({
      getProvider: jest.fn(async (): Promise<any> => ({ id: "google", apiVersion: "v1beta" })),
    });
    svc.resolveApiVersionFromConfigFile = (): string | undefined => undefined;

    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("uses the code default when nothing configures a version", async () => {
    const svc = newService({ getProvider: jest.fn(async (): Promise<any> => undefined) });
    svc.resolveApiVersionFromConfigFile = (): string | undefined => undefined;

    await svc.initializeClient(persona());

    // `v1beta`, not the 3.x SDK default `v1`: an unconfigured deployment must not be
    // moved to a different endpoint version by a dependency bump.
    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("still fails fast when no API key is available", async () => {
    const svc = newService();
    const previous = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      await expect(svc.initializeClient(persona({ config: {} }))).rejects.toThrow(
        /API key is not set/,
      );
      expect(constructorCalls).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.GOOGLE_AI_API_KEY = previous;
    }
  });

  it("does not swallow a failed model lookup", async () => {
    const svc = newService();
    modelsGet.mockRejectedValueOnce(new Error("404 model not found") as never);

    await expect(svc.initializeClient(persona())).rejects.toThrow(/not found/i);
  });
});
