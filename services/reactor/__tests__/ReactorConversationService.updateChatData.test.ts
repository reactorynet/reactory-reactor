import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import mongoose from "mongoose";

/**
 * Regression guard for the chat-data update path.
 *
 * The bug this covers: the GraphQL layer built its mutation response with
 * `{ __typename, ...chatState }`. When `chatState` is a Mongoose document a
 * spread yields only `{ $__, _doc }` — every field reads as `undefined`, so the
 * client optimistically patched the row with undefined values and the widget
 * only corrected itself after a refresh.
 */

const mockFindOneAndUpdate = jest.fn();

jest.mock("@reactory/server-modules/reactory-reactor/models/ReactorChatState", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: any[]) => mockFindOneAndUpdate(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ReactorConversationService = require("../ReactorConversationService").default;
const proto: any = ReactorConversationService.prototype;

const SESSION_ID = "6a7197689f439483800a6782";

/**
 * Build a real Mongoose document (no connection needed) so the test exercises
 * the same object shape the service returns in production.
 */
const buildMongooseDoc = () => {
  const schema = new mongoose.Schema({
    title: String,
    summary: String,
    tags: [String],
    icon: String,
    color: String,
  });
  const Model = mongoose.model(`ChatDataRegression${Date.now()}`, schema);
  return new Model({
    title: "Auth token refresh",
    summary: "Fixing the refresh-token race.",
    tags: ["auth", "bugfix"],
    icon: "check_circle",
    color: "#2e7d32",
  });
};

describe("ReactorConversationService.updateChatData", () => {
  const makeSelf = () => ({
    validateChatSessionId: jest.fn(),
    sessionLog: jest.fn(),
    context: { user: { _id: "69d07f167fd4889f4b621c95" } },
  });

  beforeEach(() => {
    mockFindOneAndUpdate.mockReset();
  });

  it("returns a plain object whose spread exposes the metadata", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      exec: async () => buildMongooseDoc(),
    } as any);

    const result: any = await proto.updateChatData.call(
      makeSelf(),
      SESSION_ID,
      { title: "Auth token refresh" }
    );

    const spread = { __typename: "ReactorChatState", ...result };

    // Direct property access always worked; the spread is what regressed.
    expect(spread.title).toBe("Auth token refresh");
    expect(spread.summary).toBe("Fixing the refresh-token race.");
    expect(spread.tags).toEqual(["auth", "bugfix"]);
    expect(spread.icon).toBe("check_circle");
    expect(spread.color).toBe("#2e7d32");
  });

  it("only writes the fields that were supplied", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      exec: async () => buildMongooseDoc(),
    } as any);

    await proto.updateChatData.call(makeSelf(), SESSION_ID, {
      icon: "error",
      color: "#c62828",
    });

    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.icon).toBe("error");
    expect(update.$set.color).toBe("#c62828");
    // A status change must not clobber the title or summary.
    expect(update.$set.title).toBeUndefined();
    expect(update.$set.summary).toBeUndefined();
    expect(update.$set.tags).toBeUndefined();
  });

  it("normalises tags: trims, drops blanks and de-duplicates", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      exec: async () => buildMongooseDoc(),
    } as any);

    await proto.updateChatData.call(makeSelf(), SESSION_ID, {
      tags: ["  auth ", "auth", "", "bugfix"],
    });

    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.tags).toEqual(["auth", "bugfix"]);
  });

  it("rejects an update with no usable fields", async () => {
    await expect(
      proto.updateChatData.call(makeSelf(), SESSION_ID, { title: "   " })
    ).rejects.toThrow(/No updatable fields/i);

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("throws when the conversation is not found or not owned by the user", async () => {
    mockFindOneAndUpdate.mockReturnValue({ exec: async () => null } as any);

    await expect(
      proto.updateChatData.call(makeSelf(), SESSION_ID, { title: "Nope" })
    ).rejects.toThrow(/not found or you do not have permission/i);
  });

  it("scopes the update to the session and the current user", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      exec: async () => buildMongooseDoc(),
    } as any);

    const self = makeSelf();
    await proto.updateChatData.call(self, SESSION_ID, { title: "Scoped" });

    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: SESSION_ID,
      user: self.context.user,
    });
  });
});
