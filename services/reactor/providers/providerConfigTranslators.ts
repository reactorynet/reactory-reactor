import { ReactorProviderConfig } from "../../../types/model.types";

/**
 * Pure translation functions that convert the normalized {@link ReactorProviderConfig}
 * into each provider's native SDK payload fragment.
 *
 * These are intentionally free of SDK/network dependencies so they can be unit
 * tested in isolation. Each provider service calls its translator and merges the
 * returned fragment into the request it sends to the underlying SDK.
 */

const DEFAULT_SCHEMA_NAME = "response";

/**
 * Parse a structured-output response body into a plain object.
 *
 * Returns `undefined` when structured output was not requested, the content is
 * absent, or the content is a string that does not parse as JSON (the raw string
 * remains available on the message's `content`). If the content is already an
 * object it is returned as-is.
 */
export function parseStructuredContent(
  content: any,
  config?: ReactorProviderConfig,
): any | undefined {
  if (!config?.structuredOutput) return undefined;
  if (content == null) return undefined;
  if (typeof content === "object") return content;
  if (typeof content !== "string") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Structured output is mutually exclusive with function-calling tools on Gemini,
 * and collides with the server-side AUTO tool-execution loop on Anthropic. When a
 * caller requests structured output we disable tools for the turn unless they have
 * explicitly asked for a tool via `toolChoice`.
 */
export function structuredOutputDisablesTools(
  config?: ReactorProviderConfig,
): boolean {
  if (!config?.structuredOutput) return false;
  // An explicit tool choice overrides the default suppression.
  if (config.toolChoice && typeof config.toolChoice === "object") return false;
  return true;
}

/**
 * OpenAI-compatible (openai / x-ai / copilot / azure-openai).
 * Produces a partial of `ChatCompletionCreateParams`.
 * Requires openai SDK >= 4.55 for `response_format.json_schema`.
 */
export function toOpenAIParams(
  config?: ReactorProviderConfig,
): Record<string, any> {
  const out: Record<string, any> = {};
  if (!config) return out;

  if (config.structuredOutput) {
    const { schema, name, strict } = config.structuredOutput;
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: name || DEFAULT_SCHEMA_NAME,
        strict: strict !== false,
        schema,
      },
    };
  }

  if (typeof config.temperature === "number") out.temperature = config.temperature;
  if (typeof config.topP === "number") out.top_p = config.topP;
  if (typeof config.maxTokens === "number") out.max_tokens = config.maxTokens;
  if (config.stopSequences?.length) out.stop = config.stopSequences;
  if (config.reasoningEffort) out.reasoning_effort = config.reasoningEffort;

  if (config.toolChoice === "none") out.tool_choice = "none";
  else if (config.toolChoice === "auto") out.tool_choice = "auto";
  else if (config.toolChoice && typeof config.toolChoice === "object") {
    out.tool_choice = {
      type: "function",
      function: { name: config.toolChoice.name },
    };
  }

  if (config.raw) Object.assign(out, config.raw);
  return out;
}

/**
 * Ollama. Produces `{ format?, options? }` fragment for `ollama.chat(...)`.
 * `format` accepts a JSON schema object (structured output) in ollama >= 0.5.
 */
export function toOllamaParams(
  config?: ReactorProviderConfig,
): { format?: any; options?: Record<string, any> } {
  const out: { format?: any; options?: Record<string, any> } = {};
  if (!config) return out;

  if (config.structuredOutput) {
    out.format = config.structuredOutput.schema;
  }

  const options: Record<string, any> = {};
  if (typeof config.temperature === "number") options.temperature = config.temperature;
  if (typeof config.topP === "number") options.top_p = config.topP;
  if (typeof config.maxTokens === "number") options.num_predict = config.maxTokens;
  if (config.stopSequences?.length) options.stop = config.stopSequences;
  if (Object.keys(options).length > 0) out.options = options;

  if (config.raw) Object.assign(out, config.raw);
  return out;
}

/**
 * Gemini (@google/genai). Produces a partial of `GenerateContentConfig` to merge
 * into the session `chatConfig`. Uses `responseJsonSchema` (raw JSON Schema) which
 * avoids converting to a Gemini `Schema` and the property-less-object downgrade
 * that the function-calling Schema converters apply.
 */
export function toGeminiConfig(
  config?: ReactorProviderConfig,
): Record<string, any> {
  const out: Record<string, any> = {};
  if (!config) return out;

  if (config.structuredOutput) {
    out.responseMimeType = "application/json";
    out.responseJsonSchema = config.structuredOutput.schema;
  }

  if (typeof config.temperature === "number") out.temperature = config.temperature;
  if (typeof config.topP === "number") out.topP = config.topP;
  if (typeof config.maxTokens === "number") out.maxOutputTokens = config.maxTokens;
  if (config.stopSequences?.length) out.stopSequences = config.stopSequences;
  if (config.responseModalities?.length) {
    out.responseModalities = config.responseModalities.map((m) => m.toUpperCase());
  }

  if (config.raw) Object.assign(out, config.raw);
  return out;
}

/**
 * Anthropic. The installed SDK (0.59.0) has no native `output_config.format`,
 * so structured output is implemented as a forced tool call: a synthetic tool
 * whose `input_schema` is the caller's schema, selected via `tool_choice`.
 *
 * Returns the synthetic tool (if any), the `tool_choice`, and sampling params.
 * The service is responsible for (a) adding `tool` to the request `tools` array,
 * and (b) treating the resulting `tool_use` block as the structured result rather
 * than dispatching it to the macro executor.
 */
export function toAnthropicParams(config?: ReactorProviderConfig): {
  tool?: { name: string; description: string; input_schema: any };
  tool_choice?: any;
  params: Record<string, any>;
  structuredToolName?: string;
} {
  const params: Record<string, any> = {};
  if (!config) return { params };

  if (typeof config.temperature === "number") params.temperature = config.temperature;
  if (typeof config.topP === "number") params.top_p = config.topP;
  if (typeof config.maxTokens === "number") params.max_tokens = config.maxTokens;
  if (config.stopSequences?.length) params.stop_sequences = config.stopSequences;

  let tool;
  let tool_choice;
  let structuredToolName;
  if (config.structuredOutput) {
    structuredToolName = config.structuredOutput.name || DEFAULT_SCHEMA_NAME;
    tool = {
      name: structuredToolName,
      description:
        "Return the response as structured data matching the provided JSON schema.",
      input_schema: config.structuredOutput.schema,
    };
    tool_choice = { type: "tool", name: structuredToolName };
  } else if (config.toolChoice === "none") {
    tool_choice = { type: "none" };
  } else if (config.toolChoice === "auto") {
    tool_choice = { type: "auto" };
  } else if (config.toolChoice && typeof config.toolChoice === "object") {
    tool_choice = { type: "tool", name: config.toolChoice.name };
  }

  if (config.raw) Object.assign(params, config.raw);
  return { tool, tool_choice, params, structuredToolName };
}
