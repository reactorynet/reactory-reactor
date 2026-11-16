import { describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { GoogleGenAI, Modality } from "@google/genai";
import fs from "fs";
import os from "os";
import path from "path";
import { loadProviders } from "../../../../ai/providers/provider-loader";
import {
  DEFAULT_GOOGLE_AI_API_VERSION,
  KNOWN_GOOGLE_AI_API_VERSIONS,
} from "../GoogleAIService";

/**
 * Wire-level proof that the configured API version is what the SDK actually puts on
 * the request, not merely what `providers.yaml` says.
 *
 * The failure this guards against is silent: `@google/genai` 3.x defaults to `v1`
 * where 1.x defaulted to `v1beta`, so "no apiVersion passed" produces a different
 * endpoint version with no error. `httpOptions.fetch` is replaced with a recorder so
 * the URL the SDK builds can be inspected without an API key or network access —
 * nothing here asserts that a model EXISTS, only that the request is addressed to the
 * version the configuration selected.
 */

const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-3.1-pro-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
];

const IMAGE_MODELS = [
  "gemini-3.1-pro-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
];

interface Recorded {
  url: string;
  method?: string;
  body?: any;
}

/** Build a client for `apiVersion`, with the transport swapped for a recorder. */
function clientWithRecorder(apiVersion?: string): { ai: GoogleGenAI; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const options: any = {
    apiKey: "not-a-real-key",
    vertexai: false,
    httpOptions: {
      fetch: async (url: any, init: any) => {
        recorded.push({
          url: typeof url === "string" ? url : url?.url ?? String(url),
          method: init?.method,
          body: init?.body,
        });
        return new Response(
          JSON.stringify({
            name: "models/probe",
            displayName: "probe",
            description: "",
            version: "001",
            inputTokenLimit: 1,
            outputTokenLimit: 1,
            supportedGenerationMethods: ["generateContent"],
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { text: "ok" },
                    { inlineData: { mimeType: "image/png", data: "AAAA" } },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  };
  // `undefined` must stay absent: that is the "SDK default" case being measured.
  if (apiVersion !== undefined) options.apiVersion = apiVersion;

  return { ai: new GoogleGenAI(options), recorded };
}

/** First path segment after the host, i.e. the API version (`v1`, `v1beta`, …). */
const versionSegment = (url: string): string => new URL(url).pathname.split("/").filter(Boolean)[0];

let configuredVersion = "";

beforeAll(() => {
  // The provider is configured in `providers.yaml`, which is seeded into the provider
  // registry. Pin the value to the code default so this suite is independent of every
  // ambient input: nothing here reads `providers.yaml`, `~/.reactor` or the environment.
  configuredVersion = DEFAULT_GOOGLE_AI_API_VERSION;
});

describe("@google/genai — the default this change exists to override", () => {
  it("addresses v1 when no apiVersion is passed (the silent regression)", async () => {
    const { ai, recorded } = clientWithRecorder(undefined);
    await ai.models.get({ model: "gemini-3.8-flash" });

    expect(recorded).toHaveLength(1);
    expect(versionSegment(recorded[0].url)).toBe("v1");
  });
});

describe("the version the provider forwards reaches the wire", () => {
  it("defaults to v1beta when the provider carries no explicit version", () => {
    expect(configuredVersion).toBe(DEFAULT_GOOGLE_AI_API_VERSION);
    expect(configuredVersion).toBe("v1beta");
    expect(KNOWN_GOOGLE_AI_API_VERSIONS).toContain(configuredVersion);
  });

  it.each(MODELS)("models.get(%s) is addressed to the configured version", async (model) => {
    const { ai, recorded } = clientWithRecorder(configuredVersion);
    await ai.models.get({ model });

    expect(recorded).toHaveLength(1);
    const url = recorded[0].url;
    expect(versionSegment(url)).toBe(configuredVersion);
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/${configuredVersion}/models/${model}`,
    );
  });

  it.each(IMAGE_MODELS)(
    "image generation for %s is requested on the configured version",
    async (model) => {
      const { ai, recorded } = clientWithRecorder(configuredVersion);
      await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: "a red cube on a desk" }] }],
        config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
      });

      expect(recorded).toHaveLength(1);
      const request = recorded[0];
      expect(request.method).toBe("POST");
      expect(versionSegment(request.url)).toBe(configuredVersion);
      expect(request.url).toBe(
        `https://generativelanguage.googleapis.com/${configuredVersion}/models/${model}:generateContent`,
      );
      // The capability the provider advertises is actually on the request.
      const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
      expect(body.generationConfig.responseModalities).toEqual(["IMAGE", "TEXT"]);
    },
  );

  it("forwards an explicit v1 without silently substituting the configured value", async () => {
    const { ai, recorded } = clientWithRecorder("v1");
    await ai.models.get({ model: "gemini-3.8-flash" });

    expect(versionSegment(recorded[0].url)).toBe("v1");
  });
});

/**
 * The seeded config itself, loaded deterministically.
 *
 * `loadProviders()` overlays `${HOME}/.reactor/providers.yaml`, so `HOME` is pointed at
 * an empty directory for the duration of each test and removed afterwards. Without
 * that, an operator whose own overlay says something else would see this suite fail —
 * a bug in the test, not in the config. Failing to clean up would also leave a temp
 * directory behind per test.
 */
describe("providers.yaml seeds a usable version", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "genai-wire-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves ${GOOGLE_AI_API_VERSION:-v1beta} to v1beta when the env var is unset", () => {
    const previous = process.env.GOOGLE_AI_API_VERSION;
    delete process.env.GOOGLE_AI_API_VERSION;
    try {
      const google = loadProviders().find((provider) => provider.id === "google");

      // Not the raw placeholder: the loader's `${VAR:-default}` interpolation must have
      // produced a real version, or every request would be addressed to a literal.
      expect(google?.apiVersion).toBe("v1beta");
      expect(google?.apiVersion).not.toContain("$");
    } finally {
      if (previous !== undefined) process.env.GOOGLE_AI_API_VERSION = previous;
    }
  });

  it("lets the env var override the seeded default", () => {
    const previous = process.env.GOOGLE_AI_API_VERSION;
    process.env.GOOGLE_AI_API_VERSION = "v1";
    try {
      const google = loadProviders().find((provider) => provider.id === "google");
      expect(google?.apiVersion).toBe("v1");
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_AI_API_VERSION;
      else process.env.GOOGLE_AI_API_VERSION = previous;
    }
  });
});
