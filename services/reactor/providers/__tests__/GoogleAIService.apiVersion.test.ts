import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";

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

beforeAll(async () => {
  const mod = await import("../GoogleAIService");
  GoogleAIService = mod.default;

  const recorder = (globalThis as any).__genaiRecorder;
  expect(recorder).toBeDefined();
  constructorCalls = recorder.constructorCalls;
  modelsGet = recorder.modelsGet;
});

beforeEach(() => {
  constructorCalls.length = 0;
  // No temp directories and no HOME manipulation: the provider no longer reads
  // `providers.yaml`, so nothing here depends on the developer's home directory.
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

/** Provider that answers every lookup with a fixed version. */
const providerServiceReturning = (apiVersion: string | undefined) => ({
  getProvider: jest.fn(async (id: string): Promise<any> =>
    apiVersion === undefined ? undefined : { id, apiVersion }),
});

/** Provider that answers per id, so a non-`google` provider can be exercised. */
const providerLookup = (byId: Record<string, string | undefined>) => ({
  getProvider: jest.fn(async (id: string): Promise<any> =>
    id in byId ? { id, apiVersion: byId[id] } : undefined,
  ),
});

const newService = (providerService?: any) => {
  const svc: any = new GoogleAIService({ apiKey: "test-key" }, mockContext);
  svc.providerService = providerService;
  return svc;
};

describe("GoogleAIService.initializeClient — apiVersion forwarding", () => {
  it("forwards the apiVersion from the provider registry", async () => {
    const svc = newService(providerServiceReturning("v1beta"));
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
    const svc = newService(providerServiceReturning("v1beta"));
    await svc.initializeClient(persona());

    // The regression was an absent key, so assert presence rather than just shape:
    // an undefined key is dropped by JSON serialisation and by the SDK's own default
    // handling, which is exactly how it failed silently before.
    expect(Object.prototype.hasOwnProperty.call(constructorCalls[0], "apiVersion")).toBe(true);
    expect(constructorCalls[0].apiVersion).toBeTruthy();
    expect(constructorCalls[0].apiVersion).not.toBe("");
    expect(modelsGet).toHaveBeenCalledWith({ model: "gemini-3.8-flash" });
  });

  it("reads the version from the provider registry", async () => {
    const providerService = providerServiceReturning("v1beta");
    const svc = newService(providerService);
    await svc.initializeClient(persona());

    // PostgreSQL is the source of truth; a value changed through `updateProvider`
    // has to reach the wire, which is what this lookup guarantees.
    expect(providerService.getProvider).toHaveBeenCalledWith("google");
    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("honours an explicit registry value of v1", async () => {
    // An operator who deliberately chose v1 gets v1. The code must not second-guess
    // configuration - only the *seeded* v1 is a problem, and that is the migration's
    // job, not the runtime's.
    const svc = newService(providerServiceReturning("v1"));
    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v1");
  });

  it("looks the provider up by persona.providerId, not a hardcoded id", async () => {
    // A database-only provider that runs through this service (e.g. `google-preview`
    // on v1alpha) must get ITS row, not the bundled `google` entry's version.
    const providerService = providerLookup({ "google-preview": "v1alpha" });
    const svc = newService(providerService);

    await svc.initializeClient(persona({ providerId: "google-preview" }));

    expect(providerService.getProvider).toHaveBeenCalledWith("google-preview");
    expect(constructorCalls[0].apiVersion).toBe("v1alpha");
  });

  it("trims a padded registry value instead of forwarding it verbatim", async () => {
    const svc = newService(providerServiceReturning("  v1beta  "));
    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("uses the code default when the registry has no version", async () => {
    const svc = newService(providerServiceReturning(undefined));
    await svc.initializeClient(persona());

    // `v1beta`, not the 3.x SDK default `v1`: an unconfigured deployment must not be
    // moved to a different endpoint version by a dependency bump.
    expect(constructorCalls[0].apiVersion).toBe("v1beta");
  });

  it("warns but still forwards an unrecognised version", async () => {
    // A typo here looks like "every model disappeared", so it is made loud without
    // blocking an operator who is deliberately trying something new.
    const svc = newService(providerServiceReturning("v9-weird"));
    await svc.initializeClient(persona());

    expect(constructorCalls[0].apiVersion).toBe("v9-weird");
  });

  it("still fails fast when no API key is available", async () => {
    const svc = newService(providerServiceReturning("v1beta"));
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
    const svc = newService(providerServiceReturning("v1beta"));
    modelsGet.mockRejectedValueOnce(new Error("404 model not found") as never);

    await expect(svc.initializeClient(persona())).rejects.toThrow(/not found/i);
  });
});
