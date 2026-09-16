import { describe, it, expect } from "@jest/globals";
import { findMissingContextLengths } from "../provider-loader";

/**
 * The registry check that surfaces a silent fallback at load time.
 *
 * A model that consumes a context window but declares no `contextLength` falls back
 * to an *invented* window at runtime. Reporting the gap when the registry loads moves
 * that discovery from a refused tool call to a log line.
 *
 * The rule keys off **capability**, not the presence of the field: image, video,
 * audio and embedding models legitimately declare no context window, so demanding the
 * field of them would produce noise that trains people to ignore the warning.
 */
describe("findMissingContextLengths", () => {
  it("reports a text model that declares no contextLength", () => {
    const gaps = findMissingContextLengths([
      {
        id: "deepseek",
        models: [{ id: "deepseek-flash", name: "DeepSeek Flash", capabilities: ["text-generation"] }],
      },
    ] as any);

    expect(gaps).toEqual([
      { providerId: "deepseek", modelId: "deepseek-flash", modelName: "DeepSeek Flash" },
    ]);
  });

  it("reports nothing for a model that declares a contextLength", () => {
    const gaps = findMissingContextLengths([
      {
        id: "deepseek",
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek Flash",
            capabilities: ["text-generation"],
            contextLength: 64000,
          },
        ],
      },
    ] as any);

    expect(gaps).toEqual([]);
  });

  it("IGNORES image, video, audio and embedding models — they have no context window", () => {
    const gaps = findMissingContextLengths([
      {
        id: "xai",
        models: [
          { id: "grok-imagine-image", name: "Image", capabilities: ["image-generation"] },
          { id: "grok-imagine-video", name: "Video", capabilities: ["video-generation"] },
          { id: "grok-tts", name: "TTS", capabilities: ["speech-synthesis"] },
          { id: "grok-realtime", name: "Realtime", capabilities: ["speech-to-text"] },
          { id: "nomic-embed-text", name: "Embed", capabilities: ["text-embedding"] },
        ],
      },
    ] as any);

    expect(gaps).toEqual([]);
  });

  it("counts a reasoning-only model as context-bearing too", () => {
    const gaps = findMissingContextLengths([
      { id: "openai", models: [{ id: "o1", name: "o1", capabilities: ["reasoning"] }] },
    ] as any);

    expect(gaps).toHaveLength(1);
  });

  it("treats a non-positive contextLength as missing", () => {
    const gaps = findMissingContextLengths([
      {
        id: "broken",
        models: [
          { id: "zero", name: "Zero", capabilities: ["text-generation"], contextLength: 0 },
          { id: "neg", name: "Neg", capabilities: ["text-generation"], contextLength: -1 },
        ],
      },
    ] as any);

    expect(gaps.map((g) => g.modelId)).toEqual(["zero", "neg"]);
  });

  it("is non-fatal for a provider with no models array", () => {
    expect(findMissingContextLengths([{ id: "empty" }] as any)).toEqual([]);
  });
});
