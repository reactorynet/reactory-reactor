import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

/**
 * B1 regression guard: importing the macro system must not require an API key.
 *
 * Why this file exists
 * --------------------
 * openai 4.x accepted `apiKey: ""` at construction and only failed when a request
 * was made. openai 7.x throws from the constructor:
 *
 *   OpenAIError: Missing credentials. Please pass an `apiKey`, ...
 *
 * `ai/openai/chat/questions/factory.ts` builds a client for `INITIAL_CHAT_STATE`,
 * and that module is on the normal import path
 * (`ai/macro/index.ts` -> `src/modules/__index.ts` in the host). So the upgrade
 * turned "no OPENAI_API_KEY" into a crash during MODULE EVALUATION, which broke
 * 14 existing suites and would have taken down any deployment that only uses
 * azure-openai, xai, copilot or a local OpenAI-compatible endpoint — none of which
 * need this client.
 *
 * The fix is a memoised lazy getter, so `INITIAL_CHAT_STATE.ai` is materialised on
 * first access rather than at import. This suite pins both halves of that:
 *
 *   1. importing the module with the key deleted must not throw
 *   2. the client must still be built on first access, and fail loudly when there
 *      is genuinely no key — the old behaviour at the point of use is preserved
 *
 * A test that only asserted (1) would pass if the client were silently replaced by
 * something that never fails, which would be a worse bug than the one being fixed.
 */

/**
 * openai 7 satisfies its credential check with `apiKey`, `adminAPIKey` OR
 * `workloadIdentity`:
 *
 *   if (!providerRuntime && !apiKey && !adminAPIKey && !workloadIdentity) throw ...
 *
 * So deleting only OPENAI_API_KEY is not enough on a runner that exports
 * OPENAI_ADMIN_KEY — the client would construct and the "fails loudly" cases below
 * would pass for the wrong reason. Both are cleared, and both restored.
 */
const CREDENTIAL_ENV_VARS = ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY"] as const;
const savedEnv: Partial<Record<(typeof CREDENTIAL_ENV_VARS)[number], string>> = {};

const clearCredentials = () => {
  for (const name of CREDENTIAL_ENV_VARS) delete process.env[name];
};

const restoreCredentials = () => {
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeAll(() => {
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) savedEnv[name] = value;
  }
  clearCredentials();
});

afterAll(restoreCredentials);

describe("importing the macro system without OPENAI_API_KEY", () => {
  it("loads the questions factory without throwing", () => {
    // Deliberately a fresh require inside the test so the assertion is about
    // module evaluation, not about a reference captured earlier.
    jest.isolateModules(() => {
      expect(() => require("../factory")).not.toThrow();
    });
  });

  it("loads the macro barrel (the host's import path) without throwing", () => {
    jest.isolateModules(() => {
      expect(() => require("../../../../macro/index")).not.toThrow();
    });
  });

  it("still fails loudly at first use when no key is configured", () => {
    jest.isolateModules(() => {
      const { INITIAL_CHAT_STATE } = require("../factory") as {
        INITIAL_CHAT_STATE: { ai: unknown };
      };

      // Importing is fine; touching the client is not. Preserving this half is the
      // point — a lazily-built client that quietly succeeded without credentials
      // would surface the misconfiguration as a confusing 401 much later.
      expect(() => INITIAL_CHAT_STATE.ai).toThrow(/credentials|apiKey/i);
    });
  });

  it("builds the client when a key is present", () => {
    process.env.OPENAI_API_KEY = "sk-wire-test-key";
    try {
      jest.isolateModules(() => {
        const { INITIAL_CHAT_STATE } = require("../factory") as {
          INITIAL_CHAT_STATE: { ai: { apiKey?: string } };
        };
        const client = INITIAL_CHAT_STATE.ai;
        expect(client).toBeTruthy();
        expect(client.apiKey).toBe("sk-wire-test-key");
      });
    } finally {
      clearCredentials();
    }
  });

  it("memoises the client rather than rebuilding it per access", () => {
    process.env.OPENAI_API_KEY = "sk-wire-test-key";
    try {
      jest.isolateModules(() => {
        const { INITIAL_CHAT_STATE } = require("../factory") as {
          INITIAL_CHAT_STATE: { ai: unknown };
        };
        expect(INITIAL_CHAT_STATE.ai).toBe(INITIAL_CHAT_STATE.ai);
      });
    } finally {
      clearCredentials();
    }
  });
});
