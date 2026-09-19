import { describe, it, expect } from "@jest/globals";
import { isSameToolResult } from "../ReactorConversationMessageService";

/**
 * The comparison that makes a replayed tool result a no-op.
 *
 * WHY IT EXISTS
 *
 * `tool_results` entries used to be appended unconditionally, so reporting the
 * same completion twice produced two copies. That is not just untidy: the array
 * lives in a JSONB column, so each duplicate cost a full rewrite of that column
 * plus another copy of the payload — for an image or a chart spec, kilobytes
 * apiece. The client-tool replay path re-reports completions *by design*, so
 * repeated reports are the expected case, not the exceptional one.
 *
 * This predicate decides whether anything actually changed, which is what lets
 * an idempotent replay cost one SELECT instead of a column rewrite.
 */
describe("isSameToolResult", () => {
  const base = {
    id: "call_abc",
    name: "chart",
    content: '{"type":"bar"}',
    timestamp: new Date("2026-09-16T10:00:00.000Z"),
  };

  it("treats an identical entry as the same", () => {
    expect(isSameToolResult(base, { ...base })).toBe(true);
  });

  it("ignores the timestamp", () => {
    // The entry records when the tool ran. A replay is the same call, so a later
    // report must not count as a change — otherwise every replay rewrites the
    // column, which is precisely the amplification being avoided.
    expect(
      isSameToolResult(base, { ...base, timestamp: new Date("2026-09-17T11:22:33.000Z") })
    ).toBe(true);
  });

  it("is insensitive to key order", () => {
    // Two writers may build the same logical entry with different key order; the
    // answer must not depend on that.
    expect(
      isSameToolResult(base, {
        timestamp: base.timestamp,
        content: base.content,
        name: base.name,
        id: base.id,
      })
    ).toBe(true);
  });

  it("detects a changed content payload", () => {
    expect(isSameToolResult(base, { ...base, content: '{"type":"line"}' })).toBe(false);
  });

  it("detects a changed name", () => {
    expect(isSameToolResult(base, { ...base, name: "d3" })).toBe(false);
  });

  it("detects a changed id", () => {
    expect(isSameToolResult(base, { ...base, id: "call_xyz" })).toBe(false);
  });

  it("detects an added field", () => {
    expect(isSameToolResult(base, { ...base, isError: true })).toBe(false);
  });

  it("detects a removed field", () => {
    const { name, ...withoutName } = base;
    expect(isSameToolResult(base, withoutName)).toBe(false);
  });

  it("compares nested objects by value", () => {
    const nested = { id: "c1", name: "chart", content: { spec: { type: "bar", data: [1, 2] } } };
    expect(
      isSameToolResult(nested, {
        id: "c1",
        name: "chart",
        content: { spec: { type: "bar", data: [1, 2] } },
      })
    ).toBe(true);
    expect(
      isSameToolResult(nested, {
        id: "c1",
        name: "chart",
        content: { spec: { type: "bar", data: [1, 3] } },
      })
    ).toBe(false);
  });

  it("identifies a value with itself", () => {
    expect(isSameToolResult(base, base)).toBe(true);
  });

  it("does not claim two different non-objects are the same", () => {
    expect(isSameToolResult("a", "b")).toBe(false);
  });

  it("handles null and undefined without throwing", () => {
    expect(isSameToolResult(null, null)).toBe(true);
    expect(isSameToolResult(undefined, undefined)).toBe(true);
    expect(isSameToolResult(null, base)).toBe(false);
    expect(isSameToolResult(base, undefined)).toBe(false);
  });
});
