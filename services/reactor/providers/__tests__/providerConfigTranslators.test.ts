import {
  toOpenAIParams,
  toOllamaParams,
  toAnthropicParams,
  toGeminiConfig,
  structuredOutputDisablesTools,
  parseStructuredContent,
} from "../providerConfigTranslators";
import { ReactorProviderConfig } from "../../../../types/model.types";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

describe("providerConfigTranslators", () => {
  describe("structuredOutputDisablesTools", () => {
    it("returns false when config is undefined", () => {
      expect(structuredOutputDisablesTools(undefined)).toBe(false);
    });

    it("returns false when there is no structuredOutput", () => {
      expect(structuredOutputDisablesTools({ temperature: 0.5 })).toBe(false);
    });

    it("returns true when structuredOutput is requested without an explicit tool", () => {
      expect(
        structuredOutputDisablesTools({ structuredOutput: { schema: SCHEMA } }),
      ).toBe(true);
    });

    it("returns false when structuredOutput is requested with an explicit tool choice", () => {
      expect(
        structuredOutputDisablesTools({
          structuredOutput: { schema: SCHEMA },
          toolChoice: { name: "search" },
        }),
      ).toBe(false);
    });
  });

  describe("toOpenAIParams", () => {
    it("returns an empty object for undefined config", () => {
      expect(toOpenAIParams(undefined)).toEqual({});
    });

    it("maps structuredOutput to response_format json_schema with defaults", () => {
      const out = toOpenAIParams({ structuredOutput: { schema: SCHEMA } });
      expect(out.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: SCHEMA },
      });
    });

    it("honors a custom schema name and strict:false", () => {
      const out = toOpenAIParams({
        structuredOutput: { schema: SCHEMA, name: "extraction", strict: false },
      });
      expect(out.response_format.json_schema.name).toBe("extraction");
      expect(out.response_format.json_schema.strict).toBe(false);
    });

    it("maps sampling and reasoning params to snake_case", () => {
      const out = toOpenAIParams({
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 512,
        stopSequences: ["END"],
        reasoningEffort: "high",
      });
      expect(out).toMatchObject({
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 512,
        stop: ["END"],
        reasoning_effort: "high",
      });
    });

    it("maps toolChoice variants", () => {
      expect(toOpenAIParams({ toolChoice: "none" }).tool_choice).toBe("none");
      expect(toOpenAIParams({ toolChoice: "auto" }).tool_choice).toBe("auto");
      expect(
        toOpenAIParams({ toolChoice: { name: "get_weather" } }).tool_choice,
      ).toEqual({ type: "function", function: { name: "get_weather" } });
    });

    it("merges raw last, allowing overrides", () => {
      const out = toOpenAIParams({
        temperature: 0.2,
        raw: { temperature: 0.9, seed: 42 },
      });
      expect(out.temperature).toBe(0.9);
      expect(out.seed).toBe(42);
    });

    it("omits keys that were not provided", () => {
      const out = toOpenAIParams({ temperature: 0.1 });
      expect(out).toEqual({ temperature: 0.1 });
      expect("top_p" in out).toBe(false);
      expect("response_format" in out).toBe(false);
    });
  });

  describe("toOllamaParams", () => {
    it("returns an empty object for undefined config", () => {
      expect(toOllamaParams(undefined)).toEqual({});
    });

    it("maps structuredOutput schema to the top-level format field", () => {
      const out = toOllamaParams({ structuredOutput: { schema: SCHEMA } });
      expect(out.format).toEqual(SCHEMA);
    });

    it("collects sampling params under options with ollama-native names", () => {
      const out = toOllamaParams({
        temperature: 0.3,
        topP: 0.8,
        maxTokens: 256,
        stopSequences: ["STOP"],
      });
      expect(out.options).toEqual({
        temperature: 0.3,
        top_p: 0.8,
        num_predict: 256,
        stop: ["STOP"],
      });
    });

    it("omits options entirely when no sampling params are set", () => {
      const out = toOllamaParams({ structuredOutput: { schema: SCHEMA } });
      expect("options" in out).toBe(false);
    });
  });

  describe("toAnthropicParams", () => {
    it("returns just params for undefined config", () => {
      expect(toAnthropicParams(undefined)).toEqual({ params: {} });
    });

    it("builds a forced schema tool for structured output", () => {
      const { tool, tool_choice, structuredToolName } = toAnthropicParams({
        structuredOutput: { schema: SCHEMA, name: "extraction" },
      });
      expect(structuredToolName).toBe("extraction");
      expect(tool).toEqual({
        name: "extraction",
        description: expect.any(String),
        input_schema: SCHEMA,
      });
      expect(tool_choice).toEqual({ type: "tool", name: "extraction" });
    });

    it("defaults the schema tool name to 'response'", () => {
      const { structuredToolName } = toAnthropicParams({
        structuredOutput: { schema: SCHEMA },
      });
      expect(structuredToolName).toBe("response");
    });

    it("maps sampling params to anthropic names", () => {
      const { params } = toAnthropicParams({
        temperature: 0.4,
        topP: 0.7,
        maxTokens: 1024,
        stopSequences: ["###"],
      });
      expect(params).toMatchObject({
        temperature: 0.4,
        top_p: 0.7,
        max_tokens: 1024,
        stop_sequences: ["###"],
      });
    });

    it("maps a bare toolChoice when there is no structured output", () => {
      expect(toAnthropicParams({ toolChoice: "none" }).tool_choice).toEqual({
        type: "none",
      });
      expect(
        toAnthropicParams({ toolChoice: { name: "search" } }).tool_choice,
      ).toEqual({ type: "tool", name: "search" });
    });

    it("prefers structured output over an explicit toolChoice", () => {
      const { tool_choice } = toAnthropicParams({
        structuredOutput: { schema: SCHEMA, name: "resp" },
        toolChoice: { name: "search" },
      });
      expect(tool_choice).toEqual({ type: "tool", name: "resp" });
    });
  });

  describe("toGeminiConfig", () => {
    it("returns an empty object for undefined config", () => {
      expect(toGeminiConfig(undefined)).toEqual({});
    });

    it("maps structuredOutput to responseMimeType + responseJsonSchema (raw schema)", () => {
      const out = toGeminiConfig({ structuredOutput: { schema: SCHEMA } });
      expect(out.responseMimeType).toBe("application/json");
      expect(out.responseJsonSchema).toEqual(SCHEMA);
      // no lossy conversion to a Gemini Schema
      expect(out.responseSchema).toBeUndefined();
    });

    it("maps sampling params to gemini camelCase names", () => {
      const out = toGeminiConfig({
        temperature: 0.5,
        topP: 0.6,
        maxTokens: 800,
        stopSequences: ["<end>"],
      });
      expect(out).toMatchObject({
        temperature: 0.5,
        topP: 0.6,
        maxOutputTokens: 800,
        stopSequences: ["<end>"],
      });
    });

    it("uppercases response modalities", () => {
      const out = toGeminiConfig({ responseModalities: ["text", "image"] });
      expect(out.responseModalities).toEqual(["TEXT", "IMAGE"]);
    });
  });

  describe("parseStructuredContent", () => {
    it("returns undefined when structured output was not requested", () => {
      expect(parseStructuredContent('{"a":1}', {})).toBeUndefined();
      expect(parseStructuredContent('{"a":1}', undefined)).toBeUndefined();
    });

    it("parses a JSON string when structured output was requested", () => {
      expect(
        parseStructuredContent('{"answer":"42"}', {
          structuredOutput: { schema: SCHEMA },
        }),
      ).toEqual({ answer: "42" });
    });

    it("returns an already-parsed object as-is", () => {
      const obj = { answer: "42" };
      expect(
        parseStructuredContent(obj, { structuredOutput: { schema: SCHEMA } }),
      ).toBe(obj);
    });

    it("returns undefined for invalid JSON (raw content is preserved elsewhere)", () => {
      expect(
        parseStructuredContent("not json", { structuredOutput: { schema: SCHEMA } }),
      ).toBeUndefined();
    });

    it("returns undefined for null/empty content", () => {
      const cfg = { structuredOutput: { schema: SCHEMA } };
      expect(parseStructuredContent(null, cfg)).toBeUndefined();
      expect(parseStructuredContent(undefined, cfg)).toBeUndefined();
    });
  });
});
