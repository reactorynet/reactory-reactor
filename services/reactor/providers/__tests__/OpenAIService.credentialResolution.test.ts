import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { ObjectId } from "mongodb";
import { StreamingMode } from "../../types/streaming.types";
import OpenAIService from "../OpenAIService";

/**
 * R1 / R2 / R3 regressions raised in review on PR #68 (openai 4.87.3 -> 7.56.0).
 *
 * These exercise the REAL `initializeClient` + the REAL openai@7 client, replacing only
 * `globalThis.fetch`. That matters: the SDK captures `fetch` at construction, so the
 * request headers below are the ones the installed client actually emits — which is the
 * only way to prove a credential did or did not travel.
 *
 * WHAT WENT WRONG ON THE FIRST PASS
 * ---------------------------------
 * `createService` in the wire-parity suite always passed an explicit `props.apiKey`, so
 * `initializeClient`'s `apiKey || process.env.<FAMILY>` short-circuited on the first
 * operand and the environment path was never reached. That is precisely where 4.x and
 * 7.x differ:
 *
 *   apiKey: ""         4.x constructs, 401s later     7.x THROWS at construction
 *   env var = ""       4.x readEnv -> ""              7.x readEnv -> undefined
 *   apiKey: undefined  4.x -> OPENAI_API_KEY          7.x -> OPENAI_API_KEY, or
 *                                                         OPENAI_ADMIN_KEY
 *
 * And because the SDK destructures with `apiKey = readEnv('OPENAI_API_KEY') ?? null`,
 * an absent key is not "send nothing" — it is "borrow the OpenAI key". Combined with the
 * xai / copilot / azure-openai branches, that meant an OpenAI key could go out as
 * `Authorization: Bearer` to api.x.ai or models.inference.ai.azure.com. Same shape for
 * `organization` (OPENAI_ORG_ID) and, new in v7, OPENAI_CUSTOM_HEADERS.
 */

const captures: Array<{ url: string; headers: Record<string, string> }> = [];
let originalFetch: any;

const mockContext: any = {
  log: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  getService: (): void => undefined,
  user: { _id: new ObjectId(), id: new ObjectId().toString() },
  partner: { _id: new ObjectId() },
};

const RELEVANT_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_API_BASE_URL",
  "X_AI_API_KEY",
  "XAI_API_BASE_URL",
  "GITHUB_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
];
const savedEnv: Record<string, string | undefined> = {};

function installRecorder(): void {
  originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw.forEach === "function") {
      raw.forEach((v: string, k: string) => {
        headers[String(k).toLowerCase()] = String(v);
      });
    } else if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    captures.push({ url, headers });
    // 400 keeps the client from retrying; we only care about what it sent.
    return new Response(JSON.stringify({ error: { message: "recorded" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
}

function makeService(providerId: string, props: any = {}): any {
  const service: any = new OpenAIService(
    { streamingMode: StreamingMode.NONE, $services: {}, ...props } as any,
    mockContext,
  );
  const persona: any = {
    id: `persona-${providerId}`,
    name: "credential resolution",
    providerId,
    modelId: "gpt-4o",
    systemPrompt: "test",
    config: { streamingPace: { targetIntervalMs: 1, minChunkSize: 1, flushTimeoutMs: 5 } },
  };
  service.personaProvider = { getPersona: async (): Promise<any> => persona };
  service.macroService = { listMacrosForPersona: async (): Promise<any[]> => [] };
  service.streamingTransportManager = { sendEventToSession: async (): Promise<void> => undefined };
  service.chatState = { id: "cred-session", personaId: persona.id, modelId: persona.modelId, persona, history: [], tools: [] };
  return service;
}

/** Drive the real client far enough to emit exactly one request. */
async function emitOneRequest(service: any): Promise<void> {
  await service.initializeClient(service.chatState.persona);
  try {
    await service.ai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  } catch {
    /* the recorder answers 400 on purpose */
  }
}

beforeEach(() => {
  for (const name of RELEVANT_ENV) savedEnv[name] = process.env[name];
  for (const name of RELEVANT_ENV) delete process.env[name];
  captures.length = 0;
  installRecorder();
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  for (const name of RELEVANT_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("R2 — per-family credential resolution", () => {
  const families = [
    { providerId: "xai", envVar: "X_AI_API_KEY", host: "api.x.ai" },
    { providerId: "copilot", envVar: "GITHUB_TOKEN", host: "models.inference.ai.azure.com" },
    { providerId: "azure-openai", envVar: "AZURE_OPENAI_API_KEY", host: "azure.com" },
  ];

  for (const { providerId, envVar, host } of families) {
    it(`${providerId}: the family env var is the bearer token when props.apiKey is unset`, async () => {
      process.env[envVar] = "sk-family-key";
      process.env.OPENAI_API_KEY = "sk-openai-key";
      if (providerId === "azure-openai") process.env.AZURE_OPENAI_ENDPOINT = "https://wire.openai.azure.com";

      const service = makeService(providerId);
      await emitOneRequest(service);

      expect(captures.length).toBeGreaterThan(0);
      expect(captures[0].url).toContain(host);
      expect(captures[0].headers.authorization).toBe("Bearer sk-family-key");
      // The decisive assertion: the OpenAI key did not leak to a third party.
      expect(captures[0].headers.authorization).not.toContain("sk-openai-key");
    });

    it(`${providerId}: no family key does NOT send the OpenAI key to ${host}`, async () => {
      process.env.OPENAI_API_KEY = "sk-openai-key";
      if (providerId === "azure-openai") process.env.AZURE_OPENAI_ENDPOINT = "https://wire.openai.azure.com";

      const service = makeService(providerId);

      // Either construction fails loudly (correct) or it must not have emitted the OpenAI
      // key. Both are acceptable outcomes; silently borrowing is not.
      let threw = false;
      try {
        await emitOneRequest(service);
      } catch {
        threw = true;
      }

      if (threw) {
        expect(captures).toHaveLength(0);
      } else {
        for (const capture of captures) {
          expect(capture.headers.authorization ?? "").not.toContain("sk-openai-key");
        }
      }
    });
  }
});

describe("R3 — OpenAI-specific headers do not reach third-party endpoints", () => {
  it("does not pass OpenAI-Organization / OpenAI-Project to xAI", async () => {
    process.env.X_AI_API_KEY = "sk-family-key";
    process.env.OPENAI_ORG_ID = "org-should-not-leak";
    process.env.OPENAI_PROJECT_ID = "proj-should-not-leak";
    // New in v7: merged into defaultHeaders for every client.
    process.env.OPENAI_CUSTOM_HEADERS = "x-openai-only: leaked";

    const service = makeService("xai");
    await emitOneRequest(service);

    expect(captures.length).toBeGreaterThan(0);
    const headers = captures[0].headers;
    expect(headers["openai-organization"]).toBeUndefined();
    expect(headers["openai-project"]).toBeUndefined();
    expect(headers["x-openai-only"]).toBeUndefined();
  });
});

describe("R1 — a malformed tool call cannot drop the whole batch", () => {
  it("normalizeCompletion keeps ids 1:1 for a call with no type and no function", () => {
    const service = makeService("openai", { apiKey: "sk-test" });

    // The shape a pass-through OpenAI-compatible provider can emit: an id, but neither
    // `type` nor `function`. Before the fix this reached `tc.function.name` and threw,
    // losing every tool result for the turn.
    const normalized = service.normalizeCompletion({
      id: "chatcmpl-1",
      model: "gpt-4o",
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_good", type: "function", function: { name: "macro.search", arguments: "{}" } },
              { id: "call_broken" },
            ],
          },
        },
      ],
    });

    const toolCalls = normalized.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].function.name).toBe("macro.search");
    expect(toolCalls[1]).toEqual({
      id: "call_broken",
      type: undefined,
      function: { name: "", arguments: "" },
    });
  });
});
