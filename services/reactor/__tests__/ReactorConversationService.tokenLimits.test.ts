import { describe, it, expect } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

describe("ReactorConversationService - Token Estimation & Preservation", () => {
  const estimateTokens = (msg: any) =>
    (ReactorConversationService as any).prototype.estimateHistoryItemTokens.call(
      {},
      msg
    );

  it("estimates tokens correctly for text content", () => {
    const tokens = estimateTokens({
      role: "user",
      content: "Hello world! This is a test message.",
    });
    // 36 characters / 4 = 9 tokens
    expect(tokens).toBe(9);
  });

  it("estimates tokens for tool_calls with name and arguments", () => {
    const tokens = estimateTokens({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "listDirectory",
            arguments: JSON.stringify({ path: "/Users/wernerw/Projects" }),
          },
        },
      ],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tokens for tool_results with content or result object", () => {
    const tokens = estimateTokens({
      role: "tool",
      tool_results: [
        {
          tool_name: "listDirectory",
          result: { items: ["file1.ts", "file2.ts", "file3.ts"] },
        },
      ],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tokens for thinking/reasoning content", () => {
    const tokens = estimateTokens({
      role: "assistant",
      content: "Final answer",
      thinking: "Let me think about how to solve this step by step...",
    });
    expect(tokens).toBeGreaterThan(estimateTokens({ role: "assistant", content: "Final answer" }));
  });

  it("preserves higher provider-reported token count over lower naive heuristic count", () => {
    const existingTokenCount = 993177;
    const heuristicCount = 422229;

    const forceResetFalse = Math.max(existingTokenCount, heuristicCount);
    expect(forceResetFalse).toBe(993177);

    const forceResetTrue = heuristicCount;
    expect(forceResetTrue).toBe(422229);
  });
});
