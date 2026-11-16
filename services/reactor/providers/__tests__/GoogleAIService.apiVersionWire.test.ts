import { describe, it, expect, beforeAll } from "@jest/globals";
import { GoogleGenAI, Modality } from "@google/genai";
import { loadProviders } from "../../../../ai/providers/provider-loader";
import { resolveGoogleApiVersion } from "../GoogleAIService";

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
  delete process.env.GOOGLE_AI_API_VERSION;
  const google = loadProviders().find((provider) => provider.id === "google");
  configuredVersion = resolveGoogleApiVersion({ yaml: google?.apiVersion }).apiVersion;
});

describe("@google/genai — the default this change exists to override", () => {
  it("addresses v1 when no apiVersion is passed (the silent regression)", async () => {
    const { ai, recorded } = clientWithRecorder(undefined);
    await ai.models.get({ model: "gemini-3.8-flash" });

    expect(recorded).toHaveLength(1);
    expect(versionSegment(recorded[0].url)).toBe("v1");
  });
});

describe("providers.yaml apiVersion reaches the wire", () => {
  it("is configured (providers.yaml declares the google provider's version)", () => {
    expect(configuredVersion).toBeTruthy();
    expect(configuredVersion).not.toBe("v1");
    expect(configuredVersion).toBe("v1beta");
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
