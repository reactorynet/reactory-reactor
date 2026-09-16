import { describe, it, expect } from "@jest/globals";
import ReactorConversationMessageService, {
  MESSAGE_WINDOW,
  resolveWindowLimit,
  resolveWindowStart,
  buildMessageSearchText,
  sanitizeForPostgres,
} from "../ReactorConversationMessageService";

/**
 * A DataSource stub that reports itself as uninitialised. Exercises the
 * degradation path every caller relies on in step 3a: with Postgres absent or
 * not yet initialised the store must no-op rather than throw, because the Mongo
 * history array is still the source of truth.
 */
const unavailableService = () =>
  new ReactorConversationMessageService({ isInitialized: false } as any);

describe("ReactorConversationMessageService window contract", () => {
  describe("resolveWindowLimit", () => {
    it("defaults to 100 when no limit is supplied", () => {
      expect(resolveWindowLimit(undefined)).toBe(MESSAGE_WINDOW.DEFAULT_LIMIT);
      expect(resolveWindowLimit(undefined)).toBe(100);
    });

    it("caps a request at the hard maximum of 500", () => {
      expect(resolveWindowLimit(5000)).toBe(MESSAGE_WINDOW.MAX_LIMIT);
      expect(resolveWindowLimit(5000)).toBe(500);
    });

    it("honours a limit within range and floors fractions", () => {
      expect(resolveWindowLimit(250)).toBe(250);
      expect(resolveWindowLimit(42.9)).toBe(42);
    });

    it("treats zero or negative limits as unset rather than shrinking to one item", () => {
      expect(resolveWindowLimit(0)).toBe(100);
      expect(resolveWindowLimit(-5)).toBe(100);
    });

    it("treats non-finite input as unset", () => {
      expect(resolveWindowLimit(Number.NaN)).toBe(100);
      expect(resolveWindowLimit(Number.POSITIVE_INFINITY)).toBe(100);
    });
  });

  describe("resolveWindowStart", () => {
    it("keeps the tail start when it already begins on a user message", () => {
      expect(
        resolveWindowStart({ tailOldestSeq: 40, tailOldestRole: "user" })
      ).toBe(40);
    });

    it("expands backwards to the nearest earlier user message", () => {
      // A naive last-N slice begins on an assistant turn; the nearest earlier
      // user sits at seq 12.
      expect(
        resolveWindowStart({
          tailOldestSeq: 20,
          tailOldestRole: "assistant",
          anchorSeq: 12,
        })
      ).toBe(12);
    });

    it("prefers the backward anchor over the forward one", () => {
      expect(
        resolveWindowStart({
          tailOldestSeq: 20,
          tailOldestRole: "tool",
          anchorSeq: 12,
          forwardAnchorSeq: 25,
        })
      ).toBe(12);
    });

    it("falls forward to the first user when none precedes the slice", () => {
      expect(
        resolveWindowStart({
          tailOldestSeq: 5,
          tailOldestRole: "assistant",
          anchorSeq: null,
          forwardAnchorSeq: 9,
        })
      ).toBe(9);
    });

    it("falls back to the tail start when no user message exists at all", () => {
      expect(
        resolveWindowStart({
          tailOldestSeq: 7,
          tailOldestRole: "assistant",
          anchorSeq: null,
          forwardAnchorSeq: null,
        })
      ).toBe(7);
    });

    it("ignores a non-finite anchor", () => {
      expect(
        resolveWindowStart({
          tailOldestSeq: 7,
          tailOldestRole: "tool",
          anchorSeq: Number.NaN,
        })
      ).toBe(7);
    });
  });

  describe("buildMessageSearchText", () => {
    it("flattens string content", () => {
      expect(buildMessageSearchText({ content: "hello world" })).toBe("hello world");
    });

    it("flattens an array of content parts", () => {
      expect(
        buildMessageSearchText({
          content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
        })
      ).toBe("first\nsecond");
    });

    it("includes reasoning text so search covers thinking", () => {
      expect(
        buildMessageSearchText({ content: "answer", thinking: "reasoning" })
      ).toBe("answer\nreasoning");
    });

    it("returns null when there is nothing to index", () => {
      expect(buildMessageSearchText({ content: null })).toBeNull();
      expect(buildMessageSearchText({ content: "" })).toBeNull();
      expect(buildMessageSearchText({})).toBeNull();
    });
  });
});

describe("ReactorConversationMessageService graceful degradation", () => {
  it("reports itself unavailable when the DataSource is not initialised", () => {
    expect(unavailableService().isAvailable()).toBe(false);
  });

  it("returns null from appendMessage instead of throwing", async () => {
    await expect(
      unavailableService().appendMessage("aaaaaaaaaaaaaaaaaaaaaaaa", {
        role: "user",
        content: "hi",
      })
    ).resolves.toBeNull();
  });

  it("returns an empty window when unavailable", async () => {
    const { items, window } = await unavailableService().getHistoryWindow(
      "aaaaaaaaaaaaaaaaaaaaaaaa"
    );

    expect(items).toEqual([]);
    expect(window).toEqual({
      total: 0,
      returned: 0,
      hasMoreBefore: false,
      oldestId: null,
      newestId: null,
    });
  });

  it("returns zero counts and no search hits when unavailable", async () => {
    const service = unavailableService();

    await expect(
      service.countForConversation("aaaaaaaaaaaaaaaaaaaaaaaa")
    ).resolves.toBe(0);
    await expect(service.searchConversationIds("anything")).resolves.toEqual([]);
    await expect(
      service.deleteForConversation("aaaaaaaaaaaaaaaaaaaaaaaa")
    ).resolves.toBe(0);
  });

  it("returns defaults from nextSeq when unavailable", async () => {
    await expect(
      unavailableService().nextSeq("aaaaaaaaaaaaaaaaaaaaaaaa")
    ).resolves.toBe(1);
  });

  it("does not prune anything when unavailable", async () => {
    await expect(
      unavailableService().pruneOrphanedMessages("aaaaaaaaaaaaaaaaaaaaaaaa", [
        "65f0000000000000000000ab",
      ])
    ).resolves.toBe(0);
  });
});

describe("ReactorConversationMessageService row mapping", () => {
  it("exposes the mongo id as the message id so paging cursors stay stable", () => {
    const service = unavailableService();
    const [message] = service.toMessages([
      {
        mongoId: "65f0000000000000000000ab",
        role: "assistant",
        content: "hello",
        archived: false,
      } as any,
    ]);

    expect(message.id).toBe("65f0000000000000000000ab");
    expect(message._id).toBe("65f0000000000000000000ab");
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("hello");
    expect(message.archived).toBe(false);
  });

  it("maps the provider response and archive metadata through", () => {
    const service = unavailableService();
    const archivedAt = new Date("2026-02-01T10:00:00.000Z");

    const [message] = service.toMessages([
      {
        mongoId: "65f0000000000000000000cd",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", function: { name: "shell" } }],
        providerResponse: { usage: { total_tokens: 42 } },
        rating: 5,
        archived: true,
        archivedAt,
        archivedReason: "compacted",
        messageTs: new Date("2026-01-31T09:00:00.000Z"),
      } as any,
    ]);

    // `response` must survive: token/cost analytics read `usage` from it.
    expect(message.response).toEqual({ usage: { total_tokens: 42 } });
    expect(message.tool_calls).toEqual([{ id: "call_1", function: { name: "shell" } }]);
    expect(message.rating).toBe(5);
    expect(message.archived).toBe(true);
    expect(message.archivedAt).toEqual(archivedAt);
    expect(message.archivedReason).toBe("compacted");
    expect(message.timestamp).toEqual(new Date("2026-01-31T09:00:00.000Z"));
  });

  it("falls back to createdAt when no message timestamp was stored", () => {
    const service = unavailableService();
    const createdAt = new Date("2026-03-01T00:00:00.000Z");

    const [message] = service.toMessages([
      {
        mongoId: "65f0000000000000000000ef",
        role: "user",
        content: "hi",
        archived: false,
        createdAt,
      } as any,
    ]);

    expect(message.timestamp).toEqual(createdAt);
  });
});

/**
 * NUL-byte handling.
 *
 * Postgres rejects `\u0000` in both `text` and `jsonb` (SQLSTATE 22P05), and a
 * real conversation carried a binary PNG payload containing one inside a tool
 * result — which aborted the first corpus-wide backfill. These cases lock in the
 * stripping so it cannot regress.
 */
describe("ReactorConversationMessageService NUL sanitisation", () => {
  const NUL = "\u0000";

  it("strips NUL characters from plain strings", () => {
    expect(sanitizeForPostgres(`a${NUL}b`)).toBe("ab");
  });

  it("strips NUL characters nested inside objects and arrays", () => {
    const input = {
      source: `\u0089PNG\r\n\u001a\n${NUL}rest`,
      parts: [{ text: `before${NUL}after` }, `top${NUL}level`],
      meta: { deep: { value: `x${NUL}y` } },
    };

    const output: any = sanitizeForPostgres(input);

    expect(output.source).toBe("\u0089PNG\r\n\u001a\nrest");
    expect(output.parts[0].text).toBe("beforeafter");
    expect(output.parts[1]).toBe("toplevel");
    expect(output.meta.deep.value).toBe("xy");
  });

  it("leaves values without NUL characters untouched", () => {
    const input = { role: "assistant", content: "hello", count: 3, flag: true, nil: null };

    expect(sanitizeForPostgres(input)).toEqual(input);
  });

  it("preserves non-string primitives and Date instances", () => {
    const when = new Date("2026-05-01T00:00:00.000Z");

    expect(sanitizeForPostgres(42)).toBe(42);
    expect(sanitizeForPostgres(true)).toBe(true);
    expect(sanitizeForPostgres(null)).toBeNull();
    expect(sanitizeForPostgres(undefined)).toBeUndefined();
    expect(sanitizeForPostgres(when)).toBe(when);
  });

  it("leaves BSON types alone so ids and binaries are not flattened to empty objects", () => {
    const objectId = { _bsontype: "ObjectId", toHexString: () => "65f0000000000000000000ab" };
    const binary = { _bsontype: "Binary", buffer: [1, 2, 3] };

    expect(sanitizeForPostgres(objectId)).toBe(objectId);
    expect(sanitizeForPostgres(binary)).toBe(binary);
  });

  it("uses toObject() for document-like values instead of walking internals", () => {
    const document = {
      $__parent: "internal-bookkeeping",
      role: "tool",
      toObject: () => ({ role: "tool", content: `has${NUL}nul` }),
    };

    const output: any = sanitizeForPostgres(document);

    expect(output.role).toBe("tool");
    expect(output.content).toBe("hasnul");
    expect(output.$__parent).toBeUndefined();
  });
});