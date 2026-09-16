import { describe, it, expect } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

const proto: any = (ReactorConversationService as any).prototype;

/**
 * `buildHistoryWindow` is a pure selection routine over the persisted history
 * array. It only depends on `historyItemId`, so it can be exercised without a
 * full service instance or database.
 */
const build = (
  history: any[],
  options?: { historyLimit?: number; before?: string; includeSystem?: boolean }
) =>
  proto.buildHistoryWindow.call(
    { historyItemId: proto.historyItemId },
    history,
    options
  ) as {
    items: any[];
    window: {
      total: number;
      returned: number;
      hasMoreBefore: boolean;
      oldestId: string | null;
      newestId: string | null;
    };
  };

const ids = (items: any[]) => items.map((i) => i._id);
const roles = (items: any[]) => items.map((i) => i.role);

/** A user/assistant/tool triple, mirroring how real turns are persisted. */
const exchange = (n: number) => [
  { role: "user", _id: `u${n}` },
  { role: "assistant", _id: `a${n}` },
  { role: "tool", _id: `t${n}` },
];

const users = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: "user", _id: `u${i}` }));

describe("ReactorConversationService.buildHistoryWindow", () => {
  it("keeps the system message and returns a trailing window", () => {
    const history = [
      { role: "system", _id: "sys" },
      ...exchange(1),
      ...exchange(2),
    ];

    const { items, window } = build(history, { historyLimit: 3 });

    expect(items[0].role).toBe("system");
    expect(ids(items)).toEqual(["sys", "u2", "a2", "t2"]);
    expect(window.total).toBe(7);
    expect(window.returned).toBe(4);
    expect(window.hasMoreBefore).toBe(true);
    expect(window.oldestId).toBe("u2");
    expect(window.newestId).toBe("t2");
  });

  it("expands backwards to the nearest user rather than starting mid-exchange", () => {
    const history = [...exchange(1), ...exchange(2), ...exchange(3)];

    // A naive last-2 slice would begin on a3, mid-exchange.
    const { items, window } = build(history, {
      historyLimit: 2,
      includeSystem: false,
    });

    expect(ids(items)).toEqual(["u3", "a3", "t3"]);
    expect(items[0].role).toBe("user");
    expect(window.hasMoreBefore).toBe(true);
  });

  it("anchors the window on a user message", () => {
    const history = [
      { role: "system", _id: "sys" },
      ...exchange(1),
      ...exchange(2),
      ...exchange(3),
    ];

    const { items } = build(history, { historyLimit: 4 });
    const nonSystem = items.filter((i) => i.role !== "system");

    expect(nonSystem[0].role).toBe("user");
  });

  it("defaults to 100 non-system items", () => {
    const { items, window } = build(users(150), { includeSystem: false });

    expect(items.length).toBe(100);
    expect(window.returned).toBe(100);
    expect(window.total).toBe(150);
    expect(window.hasMoreBefore).toBe(true);
  });

  it("caps the requested limit at 500", () => {
    const { items, window } = build(
      [{ role: "system", _id: "sys" }, ...users(600)],
      { historyLimit: 5000 }
    );

    // 500 non-system items plus the system message.
    expect(items.length).toBe(501);
    expect(window.returned).toBe(501);
  });

  it("treats a zero or negative limit as the default rather than one item", () => {
    const all = users(10);

    const zero = build(all, { historyLimit: 0, includeSystem: false });
    const negative = build(all, { historyLimit: -5, includeSystem: false });

    // A bad limit must never silently shrink the window to a single item.
    expect(zero.items.length).toBe(10);
    expect(negative.items.length).toBe(10);
  });

  it("supports the before cursor for paging older items", () => {
    const { items, window } = build(users(10), {
      before: "u5",
      historyLimit: 2,
      includeSystem: false,
    });

    expect(ids(items)).toEqual(["u3", "u4"]);
    expect(window.hasMoreBefore).toBe(true);
    expect(window.oldestId).toBe("u3");
    expect(window.newestId).toBe("u4");
  });

  it("excludes system messages on paging reads", () => {
    const history = [{ role: "system", _id: "sys" }, ...users(5)];
    const { items } = build(history, { includeSystem: false, historyLimit: 5 });

    expect(roles(items)).not.toContain("system");
  });

  it("reports no more history once the window reaches the oldest item", () => {
    const history = [{ role: "system", _id: "sys" }, ...users(3)];
    const { window } = build(history, { historyLimit: 100 });

    expect(window.hasMoreBefore).toBe(false);
    expect(window.oldestId).toBe("u0");
  });

  it("falls forward to the first user when no user precedes the slice", () => {
    const history = [
      { role: "assistant", _id: "a0" },
      { role: "tool", _id: "t0" },
      { role: "user", _id: "u1" },
      { role: "assistant", _id: "a1" },
    ];

    const { items } = build(history, { historyLimit: 1, includeSystem: false });

    expect(items[0].role).toBe("user");
    expect(items[0]._id).toBe("u1");
  });

  it("returns an empty window for an empty history", () => {
    const { items, window } = build([]);

    expect(items).toEqual([]);
    expect(window).toEqual({
      total: 0,
      returned: 0,
      hasMoreBefore: false,
      oldestId: null,
      newestId: null,
    });
  });

  it("returns everything when the history is smaller than the limit", () => {
    const history = [{ role: "system", _id: "sys" }, ...users(3)];
    const { items, window } = build(history);

    expect(items.length).toBe(4);
    expect(window.total).toBe(4);
    expect(window.hasMoreBefore).toBe(false);
  });

  it("prefers the persisted _id over the optional id field for cursors", () => {
    const history = [
      { role: "user", _id: "mongo-1", id: "legacy-1" },
      { role: "assistant", _id: "mongo-2", id: "legacy-2" },
    ];

    const { items, window } = build(history, { includeSystem: false });

    expect(window.oldestId).toBe("mongo-1");
    expect(window.newestId).toBe("mongo-2");
    expect(ids(items)).toEqual(["mongo-1", "mongo-2"]);
  });
});
