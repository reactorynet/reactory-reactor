import { describe, it, expect } from "@jest/globals";
import {
  resolveGoogleApiVersion,
  DEFAULT_GOOGLE_AI_API_VERSION,
  KNOWN_GOOGLE_AI_API_VERSIONS,
  GOOGLE_PROVIDER_ID,
} from "../GoogleAIService";

/**
 * Precedence rules for the Google API version.
 *
 * The rule itself is the fix: `@google/genai` 3.x defaults to `v1` where 1.x
 * defaulted to `v1beta`, so an unset version is a behaviour change, not a no-op.
 * These cases pin which source wins, because the wrong winner reintroduces the
 * silent endpoint switch (a registry row seeded before the config changed still
 * carries the old value). `resolveGoogleApiVersion` is pure, so it is exercised here
 * without constructing a client.
 */

describe("resolveGoogleApiVersion", () => {
  it("defaults to v1beta when nothing is configured", () => {
    const resolution = resolveGoogleApiVersion({});
    expect(resolution).toEqual({ apiVersion: "v1beta", source: "default" });
    expect(DEFAULT_GOOGLE_AI_API_VERSION).toBe("v1beta");
  });

  it("prefers providers.yaml over the provider registry", () => {
    // The registry is seeded from providers.yaml only when the table is empty, so a
    // long-lived installation can still carry the old `v1`. The file must win.
    const resolution = resolveGoogleApiVersion({ yaml: "v1beta", registry: "v1" });
    expect(resolution.apiVersion).toBe("v1beta");
    expect(resolution.source).toBe("providers.yaml");
  });

  it("prefers the environment override over everything else", () => {
    const resolution = resolveGoogleApiVersion({
      env: "v1",
      yaml: "v1beta",
      registry: "v1beta",
    });
    expect(resolution.apiVersion).toBe("v1");
    expect(resolution.source).toBe("env");
  });

  it("falls back to the registry when the config file has no value", () => {
    const resolution = resolveGoogleApiVersion({ registry: "v1beta" });
    expect(resolution.apiVersion).toBe("v1beta");
    expect(resolution.source).toBe("provider-registry");
  });

  it.each([
    ["", undefined, undefined, "default"],
    ["   ", undefined, undefined, "default"],
    [null, "", "   ", "default"],
    [undefined, " v1beta ", undefined, "providers.yaml"],
    [" v1 ", undefined, undefined, "env"],
  ])(
    "treats blank values as unset (env=%p yaml=%p registry=%p → %p)",
    (env, yaml, registry, expectedSource) => {
      const resolution = resolveGoogleApiVersion({ env, yaml, registry });
      expect(resolution.source).toBe(expectedSource);
      expect(resolution.apiVersion.trim()).toBe(resolution.apiVersion);
      expect(resolution.apiVersion).not.toBe("");
    },
  );

  it.each(KNOWN_GOOGLE_AI_API_VERSIONS)("accepts the known version %s without flagging it", (version) => {
    const resolution = resolveGoogleApiVersion({ yaml: version });
    expect(resolution.apiVersion).toBe(version);
    expect(resolution.unrecognised).toBeUndefined();
  });

  it("forwards an unrecognised version but flags it", () => {
    // A typo must not be silently 'corrected' into a version nobody asked for; it is
    // forwarded and reported, because the symptom (every model 404s) looks like a
    // model problem rather than a version problem.
    const resolution = resolveGoogleApiVersion({ yaml: "v2" });
    expect(resolution.apiVersion).toBe("v2");
    expect(resolution.unrecognised).toBe(true);
  });

  it("uses the provider id the config and registry both use", () => {
    expect(GOOGLE_PROVIDER_ID).toBe("google");
  });
});
