import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  MAX_TOOL_ITERATIONS_ENV,
  TOOL_LOOP_TRUNCATED_FINISH_REASON,
  normalizeMaxToolIterations,
  readToolLoopTruncation,
  resolveMaxToolIterations,
  toolLoopTruncationFields,
} from "../toolIterations";

/**
 * The budget resolver is the single place the "default" lives.
 *
 * These tests pin the two decisions that made the original defect possible:
 *   1. an explicit value is honoured AS GIVEN — no upward clamp, so a deliberate
 *      small budget in a test or a cheap chat is not silently inflated;
 *   2. a missing value falls back to a documented platform default rather than
 *      to whatever constant a provider happened to hardcode.
 */
describe("toolIterations — resolveMaxToolIterations", () => {
  beforeEach(() => {
    delete process.env[MAX_TOOL_ITERATIONS_ENV];
  });

  it("honours an explicitly requested budget without clamping it upward", () => {
    expect(resolveMaxToolIterations(5)).toBe(5);
    expect(resolveMaxToolIterations(200)).toBe(200);
    expect(resolveMaxToolIterations("60")).toBe(60);
  });

  it("floors fractional budgets (an iteration count is not a continuum)", () => {
    expect(resolveMaxToolIterations(12.9)).toBe(12);
  });

  it("uses the environment override when the conversation requests nothing", () => {
    expect(resolveMaxToolIterations(undefined, "60")).toBe(60);
    expect(resolveMaxToolIterations(null, "75")).toBe(75);
  });

  it("reads REACTOR_MAX_TOOL_ITERATIONS from the environment by default", () => {
    process.env[MAX_TOOL_ITERATIONS_ENV] = "90";
    expect(resolveMaxToolIterations(undefined)).toBe(90);
  });

  it("falls back to the documented platform default (200)", () => {
    expect(DEFAULT_MAX_TOOL_ITERATIONS).toBe(200);
    expect(resolveMaxToolIterations(undefined, undefined)).toBe(200);
  });

  it("never lets the environment override an explicit, smaller request", () => {
    process.env[MAX_TOOL_ITERATIONS_ENV] = "200";
    expect(resolveMaxToolIterations(3)).toBe(3);
  });

  it("ignores unusable values rather than propagating NaN into a loop bound", () => {
    expect(resolveMaxToolIterations(0, undefined)).toBe(200);
    expect(resolveMaxToolIterations(-3, undefined)).toBe(200);
    expect(resolveMaxToolIterations("not-a-number", "also-bad")).toBe(200);
    expect(resolveMaxToolIterations(NaN, undefined)).toBe(200);
    expect(resolveMaxToolIterations(Infinity, undefined)).toBe(200);
  });
});

describe("toolIterations — normalizeMaxToolIterations", () => {
  it("returns undefined for every unusable shape", () => {
    for (const bad of [undefined, null, "", "  ", "abc", 0, -1, NaN, Infinity, {}, []]) {
      expect(normalizeMaxToolIterations(bad)).toBeUndefined();
    }
  });

  it("accepts positive numbers and numeric strings", () => {
    expect(normalizeMaxToolIterations(1)).toBe(1);
    expect(normalizeMaxToolIterations("42")).toBe(42);
    expect(normalizeMaxToolIterations(7.6)).toBe(7);
  });
});

describe("toolIterations — readToolLoopTruncation", () => {
  it("detects a raw provider exhaustion (finish_reason on the choice)", () => {
    const truncation = readToolLoopTruncation({
      choices: [
        {
          finish_reason: TOOL_LOOP_TRUNCATED_FINISH_REASON,
          message: { iterationsCompleted: 200, maxToolIterations: 200 },
        },
      ],
    });

    expect(truncation).toEqual({
      iterationsCompleted: 200,
      maxToolIterations: 200,
    });
  });

  it("detects the flat ReactorChatMessage shape the conversation service returns", () => {
    const truncation = readToolLoopTruncation({
      __typename: "ReactorChatMessage",
      content: "I've reached the maximum number of tool iterations (200).",
      toolIterationLimitReached: true,
      finishReason: TOOL_LOOP_TRUNCATED_FINISH_REASON,
      iterationsCompleted: 200,
      maxToolIterations: 200,
    });

    expect(truncation).toEqual({
      iterationsCompleted: 200,
      maxToolIterations: 200,
    });
  });

  it("detects the explicit flag even when the finish reason was dropped", () => {
    expect(readToolLoopTruncation({ toolIterationLimitReached: true })).toEqual({
      iterationsCompleted: null,
      maxToolIterations: null,
    });
  });

  it("does not report a finished turn as truncated", () => {
    expect(
      readToolLoopTruncation({
        choices: [{ finish_reason: "end_turn", message: { content: "done" } }],
      }),
    ).toBeNull();

    expect(readToolLoopTruncation({ content: "done", tool_calls: [] })).toBeNull();
    expect(readToolLoopTruncation(null)).toBeNull();
    expect(readToolLoopTruncation(undefined)).toBeNull();
  });

  it("reports unknown counters as null instead of inventing numbers", () => {
    const truncation = readToolLoopTruncation({
      choices: [{ finish_reason: TOOL_LOOP_TRUNCATED_FINISH_REASON }],
    });

    expect(truncation).toEqual({
      iterationsCompleted: null,
      maxToolIterations: null,
    });
  });

  it("exposes the fields consumers need to mark a turn truncated", () => {
    expect(
      toolLoopTruncationFields({ iterationsCompleted: 3, maxToolIterations: 3 }),
    ).toEqual({
      toolIterationLimitReached: true,
      finishReason: TOOL_LOOP_TRUNCATED_FINISH_REASON,
      iterationsCompleted: 3,
      maxToolIterations: 3,
    });
  });
});
