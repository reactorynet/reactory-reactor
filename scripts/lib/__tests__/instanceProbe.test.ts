import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  deriveWriteExpectations,
  resolveMessageSource,
  resolveMongoUri,
  resolvePgConfig,
  redactUri,
  redactPg,
  Reporter,
  hasRequireApplicable,
  resolveSince,
  type StoreProbe,
} from "../instanceProbe";

/**
 * The portability contract, written down.
 *
 * These scripts are meant to run against instances at different stages of the migration, so the
 * decision of *what to assert* has to be derived from the instance rather than hardcoded. The two
 * ways to get that wrong are symmetric and both bad: assert the migrated expectations on an
 * un-migrated instance and every run reports a false failure; assert nothing and a green run means
 * nothing.
 *
 * `deriveWriteExpectations` is therefore pure and tested directly, and `Reporter` is tested for the
 * property that matters most — that `NOT APPLICABLE` is neither a pass nor a failure, and that
 * `--require-applicable` can still turn "nothing was checked" into a failure where that is wrong.
 */

const ENV_KEYS = [
  "REACTOR_MESSAGES_SOURCE",
  "REACTOR_MESSAGE_SOURCE",
  "MONGOOSE",
  "MONGODB_URI",
  "MONGO_URI",
  "MONGO_HOST",
  "MONGO_PORT",
  "MONGO_DB",
  "MONGO_USER",
  "MONGO_PASSWORD",
  "REACTORY_POSTGRES_HOST",
  "REACTORY_POSTGRES_PORT",
  "REACTORY_POSTGRES_USER",
  "REACTORY_POSTGRES_PASSWORD",
  "REACTORY_POSTGRES_DB",
  "REACTORY_POSTGRES_DATABASE",
  "POSTGRES_DB_HOST",
  "POSTGRES_USER",
  "POSTGRES_DB",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];

const clearEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

// bin/jest.sh copies config/<client>/.env.<env> into ./.env, so the deployment's real values are
// present in the test process. Start from a clean slate or these assertions test the deployment.
beforeEach(clearEnv);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
  jest.restoreAllMocks();
});

const store = (reachable: boolean, tableExists: boolean): StoreProbe => ({
  reachable,
  tableExists,
  rows: tableExists ? 10 : 0,
  conversations: tableExists ? 2 : 0,
  newest: null,
});

describe("deriveWriteExpectations — what the write path should do here", () => {
  it("un-migrated instance: the array is SUPPOSED to grow, so writesArray is true", () => {
    // This is the case the naive scripts got wrong: they asserted the array must not grow and
    // reported a failure for correct behaviour.
    const result = deriveWriteExpectations("mongo", store(true, false));
    expect(result.writesArray).toBe(true);
    expect(result.writesStore).toBe(false);
    expect(result.storeUsable).toBe(false);
    expect(result.describe).toContain("un-migrated");
  });

  it("dual-write era: Mongo authoritative, and the store IS written too", () => {
    // The mirror runs at every append site whatever the source, so in the dual-write era an append
    // lands in BOTH stores. The first version of this expectation said writesStore=false, which
    // would have made a script assert that rows must be absent — the opposite of reality. The unit
    // test caught the error in the model before any script was written against it.
    const result = deriveWriteExpectations("mongo", store(true, true));
    expect(result.writesArray).toBe(true);
    expect(result.writesStore).toBe(true);
    expect(result.storeUsable).toBe(true);
    expect(result.describe).toContain("dual-write");
  });

  it("cut over: the array is retired", () => {
    const result = deriveWriteExpectations("postgres", store(true, true));
    expect(result.writesArray).toBe(false);
    expect(result.writesStore).toBe(true);
    expect(result.describe).toContain("cut over");
  });

  it("source=postgres but store unusable: the service fails open, so the array grows", () => {
    // A misconfiguration must not make the script assert something the runtime will not do.
    const result = deriveWriteExpectations("postgres", store(true, false));
    expect(result.writesArray).toBe(true);
    expect(result.writesStore).toBe(false);
    expect(result.describe).toContain("MISCONFIGURED");

    const unreachable = deriveWriteExpectations("postgres", store(false, false));
    expect(unreachable.writesArray).toBe(true);
    expect(unreachable.writesStore).toBe(false);
    expect(unreachable.describe).toContain("MISCONFIGURED");
  });
});

describe("resolveMessageSource", () => {
  it("defaults to mongo when nothing is set", () => {
    expect(resolveMessageSource()).toBe("mongo");
  });

  it("accepts the documented plural key", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "postgres";
    expect(resolveMessageSource()).toBe("postgres");
  });

  it("accepts the singular alias — the one-letter incident must not make a script read mongo", () => {
    process.env.REACTOR_MESSAGE_SOURCE = "postgres";
    expect(resolveMessageSource()).toBe("postgres");
  });

  it("is case- and whitespace-insensitive, like the service", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "  POSTGRES  ";
    expect(resolveMessageSource()).toBe("postgres");
  });

  it("degrades anything unrecognised to mongo", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "Postgresql";
    expect(resolveMessageSource()).toBe("mongo");
  });

  it("prefers the documented key when both are present", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "postgres";
    process.env.REACTOR_MESSAGE_SOURCE = "mongo";
    expect(resolveMessageSource()).toBe("postgres");
  });

  it("ignores a present-but-empty documented key in favour of the alias", () => {
    process.env.REACTOR_MESSAGES_SOURCE = "   ";
    process.env.REACTOR_MESSAGE_SOURCE = "postgres";
    expect(resolveMessageSource()).toBe("postgres");
  });
});

describe("resolveMongoUri — no instance-specific literals", () => {
  it("prefers an explicit URI", () => {
    process.env.MONGOOSE = "mongodb://u:p@h:1/db";
    expect(resolveMongoUri()).toBe("mongodb://u:p@h:1/db");
  });

  it("accepts MONGODB_URI as well", () => {
    process.env.MONGODB_URI = "mongodb://u:p@h:2/db2";
    expect(resolveMongoUri()).toBe("mongodb://u:p@h:2/db2");
  });

  it("builds a URI from the discrete MONGO_* keys", () => {
    process.env.MONGO_HOST = "db.example";
    process.env.MONGO_PORT = "27018";
    process.env.MONGO_DB = "otherdb";
    process.env.MONGO_USER = "someone";
    process.env.MONGO_PASSWORD = "secret";
    const uri = resolveMongoUri();
    expect(uri).toBe("mongodb://someone:secret@db.example:27018/otherdb?authSource=admin");
  });

  it("does NOT invent a database name when none is configured", () => {
    // The previous hardcoded `.../reactory-reactory` fallback is exactly the bug this prevents:
    // guessing the database name is how a check silently inspects the wrong data.
    process.env.MONGO_HOST = "db.example";
    const uri = resolveMongoUri();
    expect(uri).toBe("mongodb://db.example:27017");
    expect(uri).not.toContain("reactory");
  });
});

describe("resolvePgConfig — documented precedence", () => {
  it("prefers REACTORY_POSTGRES_* over POSTGRES_*", () => {
    process.env.POSTGRES_DB_HOST = "fallback-host";
    process.env.POSTGRES_DB = "fallback-db";
    process.env.REACTORY_POSTGRES_HOST = "primary-host";
    process.env.REACTORY_POSTGRES_DB = "primary-db";
    const config = resolvePgConfig();
    expect(config.host).toBe("primary-host");
    expect(config.database).toBe("primary-db");
  });

  it("falls back to POSTGRES_* when the reactor keys are absent", () => {
    process.env.POSTGRES_DB_HOST = "fallback-host";
    process.env.POSTGRES_DB = "fallback-db";
    const config = resolvePgConfig();
    expect(config.host).toBe("fallback-host");
    expect(config.database).toBe("fallback-db");
  });

  it("parses the port as a number and defaults it", () => {
    expect(resolvePgConfig().port).toBe(5432);
    process.env.REACTORY_POSTGRES_PORT = "6543";
    expect(resolvePgConfig().port).toBe(6543);
  });

  it("never leaks a password through the printable forms", () => {
    expect(redactUri("mongodb://user:hunter2@host:27017/db")).toBe("mongodb://user:***@host:27017/db");
    expect(redactPg({ host: "h", port: 5432, user: "u", password: "hunter2", database: "d" })).toBe(
      "postgres://u:***@h:5432/d"
    );
  });
});

describe("Reporter — NOT APPLICABLE is not a lie in either direction", () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(args.map(String).join(" "));
    });
  });
  const text = () => output.join("\n");

  it("all-pass exits 0", () => {
    const r = new Reporter("t");
    r.check("a", true);
    r.check("b", true);
    expect(r.finish()).toBe(0);
    expect(text()).toContain("PASS — 2/2 checks");
  });

  it("a failure exits 1 and is named", () => {
    const r = new Reporter("t");
    r.check("good", true);
    r.check("bad", false, "because");
    expect(r.finish()).toBe(1);
    // 1 passed + 1 failed = 2 APPLICABLE checks; the denominator is applicable, not total. The
    // first version of this assertion said 1/1 and failed — a defect in the test, not the code.
    expect(text()).toContain("FAIL — 1/2 applicable checks failed");
    expect(text()).toContain("bad — because");
  });

  it("a not-applicable check does NOT fail the run, and does not count as verified", () => {
    const r = new Reporter("t");
    r.check("real", true);
    r.notApplicable("store-only", "no store table on this instance");
    expect(r.finish()).toBe(0);
    // The count must say 1 applicable, not 2 — otherwise a green run overstates what was checked.
    expect(text()).toContain("1 passed, 0 failed, 1 not applicable");
    expect(text()).toContain("1/1 applicable checks passed; 1 not applicable");
    expect(text()).toContain("store-only");
  });

  it("everything not applicable is loud but exits 0 by default", () => {
    const r = new Reporter("t");
    r.notApplicable("a", "un-migrated");
    r.notApplicable("b", "un-migrated");
    expect(r.finish()).toBe(0);
    expect(text()).toContain("NOT APPLICABLE — no check on this instance applied");
  });

  it("--require-applicable turns an all-not-applicable run into a FAILURE", () => {
    // The remaining hole: on an instance where the check should apply, a quiet pass would hide
    // that nothing ran.
    const r = new Reporter("t", { requireApplicable: true });
    r.notApplicable("a", "un-migrated");
    expect(r.finish()).toBe(1);
    expect(text()).toContain("nothing was applicable on this instance");
  });

  it("--require-applicable is satisfied by a single applicable check", () => {
    const r = new Reporter("t", { requireApplicable: true });
    r.check("real", true);
    r.notApplicable("store-only", "no store");
    expect(r.finish()).toBe(0);
  });
});

describe("argument helpers", () => {
  it("detects --require-applicable", () => {
    expect(hasRequireApplicable(["--require-applicable"])).toBe(true);
    expect(hasRequireApplicable(["--verbose"])).toBe(false);
  });

  it("resolves --since and rejects a malformed one loudly", () => {
    const explicit = resolveSince(["--since=2026-09-14T11:01:11Z"]);
    expect(explicit.toISOString()).toBe("2026-09-14T11:01:11.000Z");

    expect(() => resolveSince(["--since=not-a-date"])).toThrow(/ISO timestamp/);
  });

  it("defaults --since to a window in the past", () => {
    const before = Date.now();
    const since = resolveSince([], 15);
    expect(since.getTime()).toBeLessThan(before);
    expect(before - since.getTime()).toBeGreaterThan(14 * 60 * 1000);
  });
});
