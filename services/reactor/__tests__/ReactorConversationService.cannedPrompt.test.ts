import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import * as lodash from "lodash";
import ReactorConversationService from "../ReactorConversationService";

/**
 * sendCannedPrompt only touches this.context, this.createErrorResponse and
 * this.sendMessage, so we exercise it against a hand-built `this` to avoid
 * constructing the full service and its dependency graph.
 */

const PERSONA = {
  id: "GitGuardian",
  prompts: {
    commitReviewPrompt: {
      role: "user",
      content: "Review branch ${branch} with hint: ${hint}",
    },
    noContent: { role: "user" },
  },
  tools: [],
  macros: [],
};

function makeThis(overrides: any = {}) {
  const sendMessage = jest.fn(async (a: any) => ({
    __typename: "ReactorChatMessage",
    content: "ok",
    __args: a,
  }));
  const createErrorResponse = jest.fn((code: any, message: string, opts: any) => ({
    __typename: "ReactorErrorResponse",
    code,
    message,
    ...opts,
  }));
  const getPersona = jest.fn(async () => overrides.persona ?? PERSONA);
  const context = {
    getService: jest.fn(() => ({ getPersona })),
    utils: { lodash },
    user: {
      id: "u1",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: () => "Ada Lovelace",
    },
    error: jest.fn(),
  };
  return {
    self: { context, createErrorResponse, sendMessage },
    sendMessage,
    createErrorResponse,
    getPersona,
  };
}

const invoke = (self: any, args: any) =>
  (ReactorConversationService as any).prototype.sendCannedPrompt.call(self, args);

let svcProto: any;
beforeAll(() => {
  svcProto = (ReactorConversationService as any).prototype;
});

describe("ReactorConversationService.sendCannedPrompt", () => {
  it("renders the canned prompt with variables and delegates to sendMessage", async () => {
    const t = makeThis();
    const result = await invoke(t.self, {
      personaId: "GitGuardian",
      promptKey: "commitReviewPrompt",
      variables: { branch: "feature/x", hint: "added tests" },
      chatSessionId: "sess-1",
      providerConfig: { structuredOutput: { schema: { type: "object" } } },
    });

    expect(t.sendMessage).toHaveBeenCalledTimes(1);
    const arg = (t.sendMessage.mock.calls[0] as any[])[0];
    expect(arg.message).toBe("Review branch feature/x with hint: added tests");
    expect(arg.role).toBe("user");
    expect(arg.personaId).toBe("GitGuardian");
    expect(arg.chatSessionId).toBe("sess-1");
    expect(arg.providerConfig).toEqual({ structuredOutput: { schema: { type: "object" } } });
    expect(result.__typename).toBe("ReactorChatMessage");
  });

  it("returns a MISSING_REQUIRED_FIELD error when promptKey is absent", async () => {
    const t = makeThis();
    const result = await invoke(t.self, { personaId: "GitGuardian", promptKey: "" });
    expect(result.__typename).toBe("ReactorErrorResponse");
    expect(t.sendMessage).not.toHaveBeenCalled();
  });

  it("returns an error listing available prompts when the key is unknown", async () => {
    const t = makeThis();
    const result = await invoke(t.self, {
      personaId: "GitGuardian",
      promptKey: "doesNotExist",
    });
    expect(result.__typename).toBe("ReactorErrorResponse");
    expect(result.message).toContain("commitReviewPrompt");
    expect(t.sendMessage).not.toHaveBeenCalled();
  });

  it("returns an error when the prompt template has no content", async () => {
    const t = makeThis();
    const result = await invoke(t.self, { personaId: "GitGuardian", promptKey: "noContent" });
    expect(result.__typename).toBe("ReactorErrorResponse");
    expect(t.sendMessage).not.toHaveBeenCalled();
  });

  it("returns a render error when a template variable is missing", async () => {
    const t = makeThis();
    const result = await invoke(t.self, {
      personaId: "GitGuardian",
      promptKey: "commitReviewPrompt",
      variables: { branch: "main" }, // `hint` intentionally missing
    });
    expect(result.__typename).toBe("ReactorErrorResponse");
    expect(result.message).toContain("render");
    expect(t.sendMessage).not.toHaveBeenCalled();
  });

  it("honours an explicit role override", async () => {
    const t = makeThis();
    await invoke(t.self, {
      personaId: "GitGuardian",
      promptKey: "commitReviewPrompt",
      variables: { branch: "b", hint: "h" },
      role: "system",
    });
    const arg = (t.sendMessage.mock.calls[0] as any[])[0];
    expect(arg.role).toBe("system");
  });
});
