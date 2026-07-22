import { describe, it, expect } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

// attachStructuredContent uses no instance state, so exercise it on the prototype
// to avoid constructing the full service (and its dependency graph).
const attach = (adapted: any, providerConfig?: any) =>
  (ReactorConversationService as any).prototype.attachStructuredContent.call(
    {},
    adapted,
    providerConfig,
  );

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

describe("ReactorConversationService.attachStructuredContent", () => {
  it("attaches parsed structuredContent for a structured-output chat message", () => {
    const adapted = {
      __typename: "ReactorChatMessage",
      content: '{"answer":"42"}',
    };
    const result = attach(adapted, { structuredOutput: { schema: SCHEMA } });
    expect(result.structuredContent).toEqual({ answer: "42" });
    // raw string preserved
    expect(result.content).toBe('{"answer":"42"}');
  });

  it("is a no-op when structured output was not requested", () => {
    const adapted = { __typename: "ReactorChatMessage", content: '{"answer":"42"}' };
    const result = attach(adapted, {});
    expect(result.structuredContent).toBeUndefined();
  });

  it("is a no-op for error responses", () => {
    const adapted = { __typename: "ReactorErrorResponse", code: "X", message: "boom" };
    const result = attach(adapted, { structuredOutput: { schema: SCHEMA } });
    expect(result.structuredContent).toBeUndefined();
  });

  it("leaves structuredContent unset when content is not valid JSON", () => {
    const adapted = { __typename: "ReactorChatMessage", content: "sorry, I can't" };
    const result = attach(adapted, { structuredOutput: { schema: SCHEMA } });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toBe("sorry, I can't");
  });

  it("handles a null adapted response gracefully", () => {
    expect(attach(null, { structuredOutput: { schema: SCHEMA } })).toBeNull();
  });
});
