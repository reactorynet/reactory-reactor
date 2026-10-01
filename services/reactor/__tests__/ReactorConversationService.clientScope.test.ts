import { describe, it, expect } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

/**
 * Tenant scoping of conversation *documents* (WP-B2).
 *
 * The message log in Postgres is scoped by `client_key` (ReactoryClient), but the
 * session document in Mongo was not. That mismatch let "New chat" on one client
 * adopt a conversation with content on another client — the tenant-scoped store
 * reported it as "no content" and it was reused as a verified blank.
 *
 * These tests exercise the real clause builders on the service prototype, so a
 * change to the scoping rules fails here rather than silently reintroducing the
 * cross-client reuse bug.
 */
const proto: any = (ReactorConversationService as any).prototype;

const makeService = (context: any) => {
  const service: any = Object.create(proto);
  service.context = context;
  return service;
};

const noop = (): void => undefined;
const contextFor = (clientKey?: string, userId = "user-1") => ({
  partner: clientKey ? { key: clientKey } : undefined,
  user: { _id: userId },
  debug: noop,
  warn: noop,
  info: noop,
  error: noop,
});

describe("conversation tenant key resolution", () => {
  it("uses the request's partner key", () => {
    expect(makeService(contextFor("acme")).resolveConversationClientKey()).toBe("acme");
  });

  it("returns null when the request carries no partner", () => {
    // CLI, MCP and ops contexts may have no partner. The absence must be
    // explicit, not an accidental match-all.
    expect(makeService(contextFor()).resolveConversationClientKey()).toBeNull();
    expect(makeService({}).resolveConversationClientKey()).toBeNull();
  });
});

describe("conversationClientScope (listing + reuse)", () => {
  it("pins the tenant to the current client", () => {
    expect(makeService(contextFor("acme")).conversationClientScope()).toEqual({ clientKey: "acme" });
  });

  it("adds nothing when there is no partner, preserving legacy behaviour", () => {
    expect(makeService(contextFor()).conversationClientScope()).toEqual({});
  });

  it("is a positive equality, never a wildcard across clients", () => {
    // The clause must be able to widen to *this* client only. `$in`/`$exists`
    // would let a foreign conversation through.
    const clause: any = makeService(contextFor("acme")).conversationClientScope();
    expect(clause.clientKey).toBe("acme");
    expect(clause.clientKey).not.toHaveProperty("$in");
    expect(clause.clientKey).not.toHaveProperty("$ne");
    expect(clause.clientKey).not.toHaveProperty("$exists");
  });
});

describe("conversationReadScope (single conversation by id)", () => {
  it("adds nothing when there is no partner", () => {
    expect(makeService(contextFor()).conversationReadScope()).toEqual({});
  });

  it("allows this client's conversations and legacy unstamped ones", () => {
    const clause: any = makeService(contextFor("acme")).conversationReadScope();
    expect(clause.$or).toEqual([
      { clientKey: "acme" },
      { clientKey: { $in: [null, undefined] } },
    ]);
  });

  it("does not allow a conversation stamped with a different client", () => {
    const clause: any = makeService(contextFor("acme")).conversationReadScope();
    const serialised = JSON.stringify(clause);
    expect(serialised).toContain('"clientKey":"acme"');
    // Only the current key and the null/undefined tolerance may appear; any other
    // concrete key would mean another client's row is readable.
    expect(serialised).not.toMatch(/"clientKey":"(?!acme")/);
  });
});

describe("newConversationReuseFilter", () => {
  it("includes the client key so a foreign blank-looking chat is never reused", () => {
    const filter: any = makeService(contextFor("acme")).newConversationReuseFilter("Reactor", "standalone");
    expect(filter.clientKey).toBe("acme");
    expect(filter.personaId).toBe("Reactor");
    expect(filter.user).toBe("user-1");
  });

  it("still requires the conversation to look blank", () => {
    const filter: any = makeService(contextFor("acme")).newConversationReuseFilter("Reactor", "standalone");
    // Three arms: no array, empty array, or a lone system message.
    expect(filter.$or).toHaveLength(3);
    expect(filter.$or).toContainEqual({ history: { $exists: false } });
    expect(filter.$or).toContainEqual({ history: { $size: 0 } });
    expect(filter.$or).toContainEqual({ history: { $size: 1 }, "history.0.role": "system" });
  });

  it("scopes standalone reuse to standalone-ish use cases", () => {
    const filter: any = makeService(contextFor("acme")).newConversationReuseFilter("Reactor", "standalone");
    expect(filter.use_case.$in).toEqual(["standalone", null, undefined]);
  });

  it("scopes a non-standalone reuse to its exact use case", () => {
    const filter: any = makeService(contextFor("acme")).newConversationReuseFilter("Reactor", "content");
    expect(filter.use_case).toBe("content");
  });

  it("omits the tenant clause when there is no partner (backwards compatible)", () => {
    const filter: any = makeService(contextFor()).newConversationReuseFilter("Reactor", "standalone");
    expect(filter).not.toHaveProperty("clientKey");
  });
});
