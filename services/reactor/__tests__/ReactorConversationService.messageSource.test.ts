import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";
import { resolveMessagesSource } from "../ReactorConversationMessageService";

const proto: any = (ReactorConversationService as any).prototype;

/**
 * Source selection and the Postgres/ Mongo dispatch in `resolveHistoryWindow`.
 *
 * These are the wiring tests for step 3b: the SQL implementation itself is
 * compared against Mongo on real transcripts by
 * `scripts/checkWindowParity.ts`, so what has to be pinned here is that the flag
 * picks the right one, that nothing is forwarded that the Mongo path never
 * forwarded, and that a Postgres failure degrades to Mongo rather than to an
 * empty transcript.
 */

const ENV_KEYS = ["REACTOR_MESSAGES_SOURCE", "REACTOR_MESSAGE_SOURCE"] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];

const clearSourceEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

// bin/jest.sh copies ./config/<client>/.env.<env> into ./.env, so the real
// deployment value of either key is present in the test process. Start every
// test from a clean slate; the alias tests opt back in explicitly.
beforeEach(clearSourceEnv);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

describe("resolveMessagesSource", () => {
  it("defaults to mongo when the flag is unset", () => {
    delete process.env.REACTOR_MESSAGES_SOURCE;
    expect(resolveMessagesSource()).toBe("mongo");
  });

  it("selects postgres only for the exact value", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "postgres";
    expect(resolveMessagesSource()).toBe("postgres");
  });

  it("tolerates surrounding whitespace and casing", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "  POSTGRES ";
    expect(resolveMessagesSource()).toBe("postgres");
  });

  it("degrades a typo to mongo rather than to an unknown source", () => {
    for (const value of ["postgress", "pg", "postgres;", "true", "1", ""]) {
      process.env.REACTOR_MESSAGES_SOURCE = value;
      expect(resolveMessagesSource()).toBe("mongo");
    }
  });

  /**
   * The alias exists because \`REACTOR_MESSAGE_SOURCE\` (singular) and
   * \`REACTOR_MESSAGES_SOURCE\` (plural) differ by one letter, and an
   * unrecognised key resolves to mongo *silently* — a deployment can believe it
   * flipped the read cutover while still serving Mongo. A real deployment hit
   * exactly this, so both spellings must work.
   */
  describe("REACTOR_MESSAGE_SOURCE alias", () => {
    it("honours the singular alias when the documented name is unset", () => {
      clearSourceEnv();
      process.env.REACTOR_MESSAGE_SOURCE = "postgres";
      expect(resolveMessagesSource()).toBe("postgres");
    });

    it("degrades a typo in the alias to mongo", () => {
      clearSourceEnv();
      for (const value of ["postgress", "pg", "true", ""]) {
        process.env.REACTOR_MESSAGE_SOURCE = value;
        expect(resolveMessagesSource()).toBe("mongo");
      }
    });

    it("accepts either name with surrounding whitespace and casing", () => {
      clearSourceEnv();
      process.env.REACTOR_MESSAGE_SOURCE = "  POSTGRES ";
      expect(resolveMessagesSource()).toBe("postgres");
    });

    it("lets the documented name win when both agree", () => {
      clearSourceEnv();
      process.env.REACTOR_MESSAGES_SOURCE = "postgres";
      process.env.REACTOR_MESSAGE_SOURCE = "postgres";
      expect(resolveMessagesSource()).toBe("postgres");
    });

    it("lets the documented name win, and warns, when the two disagree", () => {
      clearSourceEnv();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        process.env.REACTOR_MESSAGES_SOURCE = "mongo";
        process.env.REACTOR_MESSAGE_SOURCE = "postgres";
        expect(resolveMessagesSource()).toBe("mongo");
        const conflicting = warn.mock.calls.filter((call) =>
          String(call[0]).includes("Conflicting")
        );
        expect(conflicting).toHaveLength(1);
        // The warning must name both keys, so a misconfigured deployment can
        // see which one it actually set.
        expect(String(conflicting[0][0])).toContain("REACTOR_MESSAGES_SOURCE");
        expect(String(conflicting[0][0])).toContain("REACTOR_MESSAGE_SOURCE");
      } finally {
        warn.mockRestore();
      }
    });

    it("resolves to mongo when neither name is set", () => {
      clearSourceEnv();
      expect(resolveMessagesSource()).toBe("mongo");
    });

    it("treats an empty value as unset rather than as a source", () => {
      clearSourceEnv();
      process.env.REACTOR_MESSAGES_SOURCE = "";
      process.env.REACTOR_MESSAGE_SOURCE = "postgres";
      // The plural is present but empty, so it is not a value: the alias applies.
      expect(resolveMessagesSource()).toBe("postgres");
    });
  });
});

const history = [
  { role: "system", _id: "sys" },
  { role: "user", _id: "u1" },
  { role: "assistant", _id: "a1" },
];

/** A `this` stub exposing only what `resolveHistoryWindow` touches. */
const makeCtx = (overrides: any = {}) => {
  const warn = jest.fn();
  return {
    ctx: {
      historyItemId: proto.historyItemId,
      buildHistoryWindow: proto.buildHistoryWindow,
      messagesSource: () => "mongo",
      getMessageStore: () => null,
      context: { warn },
      ...overrides,
    },
    warn,
  };
};

describe("resolveHistoryWindow dispatch", () => {
  it("uses the Postgres window, forwarding limit/system/archived, when the source is postgres", async () => {
    const captured: any[] = [];
    const sqlResult = {
      items: [{ id: "sql-1", role: "user" }],
      window: {
        total: 42,
        returned: 1,
        hasMoreBefore: true,
        oldestId: "sql-1",
        newestId: "sql-1",
      },
    };

    let archivedCountCalls = 0;
    const { ctx } = makeCtx({
      messagesSource: () => "postgres",
      getMessageStore: () => ({
        getHistoryWindow: async (_id: string, options: any) => {
          captured.push(options);
          return sqlResult;
        },
        countArchived: async () => {
          archivedCountCalls += 1;
          return 7;
        },
      }),
    });

    const result = await proto.resolveHistoryWindow.call(
      ctx,
      { history },
      "conv-1",
      { historyLimit: 7, includeSystem: false, includeArchived: true }
    );

    // The window comes back from the store untouched, apart from the archived
    // count the dispatch attaches for the client's expander affordance.
    expect(result.items).toEqual(sqlResult.items);
    expect(result.window).toEqual({ ...sqlResult.window, archivedCount: 7 });
    expect(archivedCountCalls).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      limit: 7,
      includeSystem: false,
      includeArchived: true,
    });
  });

  it("never touches the store when the source is mongo", async () => {
    const getHistoryWindow = jest.fn();
    const { ctx } = makeCtx({
      messagesSource: () => "mongo",
      getMessageStore: () => ({ getHistoryWindow }),
    });

    const result = await proto.resolveHistoryWindow.call(
      ctx,
      { history },
      "conv-1",
      { historyLimit: 100, includeSystem: true }
    );

    expect(getHistoryWindow).not.toHaveBeenCalled();
    // Same as the pure implementation over the array.
    const pure = proto.buildHistoryWindow.call(
      { historyItemId: proto.historyItemId },
      history,
      { historyLimit: 100, includeSystem: true }
    );
    expect(result.window).toEqual({ ...pure.window, archivedCount: 0 });
    expect(result.items.map((i: any) => i._id)).toEqual(
      pure.items.map((i: any) => i._id)
    );
  });

  it("falls back to Mongo when the store is unavailable", async () => {
    const { ctx } = makeCtx({
      messagesSource: () => "postgres",
      getMessageStore: () => null,
    });

    const result = await proto.resolveHistoryWindow.call(
      ctx,
      { history },
      "conv-1",
      { includeSystem: true }
    );

    expect(result.items.map((i: any) => i._id)).toEqual(["sys", "u1", "a1"]);
    expect(result.window.total).toBe(3);
  });

  it("falls back to Mongo — and warns — when the Postgres read throws", async () => {
    const { ctx, warn } = makeCtx({
      messagesSource: () => "postgres",
      getMessageStore: () => ({
        getHistoryWindow: async () => {
          throw new Error("connection terminated");
        },
      }),
    });

    const result = await proto.resolveHistoryWindow.call(
      ctx,
      { history },
      "conv-1",
      { includeSystem: false }
    );

    expect(result.items.map((i: any) => i._id)).toEqual(["u1", "a1"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not forward the getChatSession before cursor (pre-existing contract)", async () => {
    // The windowed getChatSession read never honoured `before`; paging flows
    // through getConversationHistoryPage. Forwarding it here would be an
    // unrelated behaviour change, so the dispatch must not introduce it.
    const captured: any[] = [];
    const { ctx } = makeCtx({
      messagesSource: () => "postgres",
      getMessageStore: () => ({
        getHistoryWindow: async (_id: string, options: any) => {
          captured.push(options);
          return {
            items: [],
            window: {
              total: 0,
              returned: 0,
              hasMoreBefore: false,
              oldestId: null,
              newestId: null,
            },
          };
        },
      }),
    });

    await proto.resolveHistoryWindow.call(ctx, { history }, "conv-1", {
      includeSystem: true,
    });

    expect(captured[0].before).toBeUndefined();
  });
});
