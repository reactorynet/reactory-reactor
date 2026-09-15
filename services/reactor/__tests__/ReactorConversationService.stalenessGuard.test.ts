import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  warnIfMongoSourceMayBeStale,
  __resetMongoStalenessWarningForTests,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

/**
 * The `mongo`-source staleness guard.
 *
 * This is the second half of the "remove the trap" decision (§45.1 part 3) and it was MISSING until
 * now — the write-path work shipped the choke point and the mirror change, and never built the
 * warning that was supposed to accompany them. It closes definition-of-done bullet 4 from §45.5
 * ("the `mongo`-source staleness warning observed in the log").
 *
 * The property being protected: after the cutover the embedded array is authoritative only for
 * messages written *before* it, so anyone pointing reads back at `mongo` must be told — rather than
 * silently served a short transcript.
 *
 * The wiring (both hooks calling the guard) is asserted structurally at the bottom, because the
 * behavioural half needs a live write. Structural + behavioural together cover it; neither alone
 * would.
 */

const MODEL_PATH = path.join(__dirname, "..", "..", "..", "models", "ReactorChatState.ts");

const captureWarnings = () => {
  const seen: string[] = [];
  jest.spyOn(console, "warn").mockImplementation((...args: any[]) => {
    seen.push(args.map(String).join(" "));
  });
  return seen;
};

beforeEach(() => {
  __resetMongoStalenessWarningForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  __resetMongoStalenessWarningForTests();
});

// NOTE: the guard's *caller* decides whether the warning fires (it is reached only when the store is
// not authoritative). The warning function itself reads no environment — so the `REACTOR_MESSAGE*`
// keys set below make no difference to these assertions. They are kept only to document that: with
// the source retired in Phase 3c step 3, no value of either key changes this behaviour.
describe("mongo-source staleness guard", () => {
  it("warns when it is called — the flag is irrelevant, only the caller's condition decides", () => {
    const warnings = captureWarnings();
    process.env.REACTOR_MESSAGES_SOURCE = "mongo";
    process.env.REACTOR_MESSAGE_SOURCE = "mongo";

    warnIfMongoSourceMayBeStale();

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("source is mongo");

    delete process.env.REACTOR_MESSAGES_SOURCE;
    delete process.env.REACTOR_MESSAGE_SOURCE;
  });

  it("warns only ONCE per process — it is called from hooks that run on every write", () => {
    const warnings = captureWarnings();
    process.env.REACTOR_MESSAGES_SOURCE = "mongo";

    warnIfMongoSourceMayBeStale();
    warnIfMongoSourceMayBeStale();
    warnIfMongoSourceMayBeStale();

    expect(warnings.length).toBe(1);

    delete process.env.REACTOR_MESSAGES_SOURCE;
  });

  it("states the CONDITION rather than asserting a fault — an un-migrated instance is legitimate", () => {
    // The softer branch is the one this process takes (no Postgres DataSource initialised here).
    // Claiming a fault would be a false alarm on an instance that has never been migrated, which is
    // exactly the class of error the portability work has been about.
    const warnings = captureWarnings();
    process.env.REACTOR_MESSAGES_SOURCE = "mongo";

    warnIfMongoSourceMayBeStale();

    const message = warnings.join("\n");
    expect(message).toContain("only authoritative for messages written BEFORE the cutover");
    expect(message).toContain("never been migrated this is expected");
    expect(message).not.toContain("WHILE A MESSAGE STORE IS CONFIGURED");

    delete process.env.REACTOR_MESSAGES_SOURCE;
  });

  it("re-arms after a reset so the once-per-process gate is testable", () => {
    const warnings = captureWarnings();
    process.env.REACTOR_MESSAGES_SOURCE = "mongo";

    warnIfMongoSourceMayBeStale();
    __resetMongoStalenessWarningForTests();
    warnIfMongoSourceMayBeStale();

    expect(warnings.length).toBe(2);

    delete process.env.REACTOR_MESSAGES_SOURCE;
  });
});

describe("staleness guard is wired into the write hooks", () => {
  // Structural, and deliberately so: driving the hooks behaviourally needs a live write, which the
  // §43.3 pilot covers. What must not regress silently is the *wiring*, so it is asserted here.
  const source = fs.readFileSync(MODEL_PATH, "utf8");

  it("both write hooks call the guard", () => {
    // Exactly the two hook call sites. The DEFINITION does not match this pattern — it reads
    // \`export const warnIfMongoSourceMayBeStale = (): void =>\`, with no parens-semicolon — so an
    // expectation of 3 was wrong, and would have masked a missing call site by counting the
    // definition instead. (If the definition vanished, tsc would fail on the unresolved symbol.)
    const calls = source.split("warnIfMongoSourceMayBeStale();").length - 1;
    expect(calls).toBe(2);
  });

  it("the guard is reached only when the store is NOT authoritative", () => {
    // Every hook guard reads: if (!isMessageStoreAuthoritative()) { warn; return next(); }
    const guards = source.split("if (!isMessageStoreAuthoritative()) {").length - 1;
    expect(guards).toBe(2);
    expect(source).toContain("warnIfMongoSourceMayBeStale();\n    return next();");
  });
});
