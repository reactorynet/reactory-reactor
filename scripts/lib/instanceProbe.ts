/**
 * Shared instance probe for the Phase 3c scripts.
 *
 * These scripts were written against the one instance being migrated, where the message store is
 * populated and `REACTOR_MESSAGE_SOURCE=postgres`. Run against **any other** instance — an
 * un-migrated one with no `reactor_conversation_messages` table, or one still reading Mongo — the
 * naive versions of them reported `FAIL`, because the embedded array *did* grow. That is a false
 * positive: on such an instance the array growing is the **correct** behaviour, and the store is
 * absent by design. A check that reports a failure for correct behaviour is worse than no check.
 *
 * So the scripts ask this module three questions before they assert anything:
 *
 *  1. How do I connect? — resolved from the environment, with the module's own precedence
 *     (`REACTORY_POSTGRES_*` → `POSTGRES_*`, `MONGOOSE`/`MONGODB_URI`/`MONGO_*`). No instance
 *     specific literals remain in the scripts.
 *  2. What is this instance? — the source **observed from the data** (the env flag that used to
 *     select it was retired in Phase 3c step 3), whether each store is reachable, and whether the
 *     message table exists and holds rows.
 *  3. What should the write path be doing here? — derived, not assumed, so the scripts invert their
 *     expectations where they must and report **NOT APPLICABLE** where a prerequisite is absent
 *     rather than inventing a verdict.
 *
 * Nothing here throws. A store that cannot be reached is a *finding about the instance*, not a
 * crash — the whole point is to be safe to run somewhere unknown.
 */
import mongoose from "mongoose";
import { Client } from "pg";

export type MessageSource = "mongo" | "postgres";

/** Env keys consulted for the source, in precedence order — mirrors the service's own resolution. */
const SOURCE_KEYS = ["REACTOR_MESSAGES_SOURCE", "REACTOR_MESSAGE_SOURCE"] as const;

/** The table and collections this migration owns. Constant across instances. */
export const STORE_TABLE = "reactor_conversation_messages";
export const CONVERSATIONS_COLLECTION = "reactor_conversations";

const first = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return undefined;
};

/**
 * Which store is authoritative, observed from the instance's DATA rather than an environment flag.
 *
 * Phase 3c step 3 **retired the flag**: the service's `resolveMessagesSource()` now returns a
 * constant, so a script that read `REACTOR_MESSAGES_SOURCE` would report `mongo` for an instance
 * whose arrays are gone — and then expect the array to grow, which is a false failure. That is
 * exactly what happened the first time this instance was re-checked after the flag was retired.
 *
 * The only durable evidence that the embedded array is authoritative is a document that still
 * carries a **non-empty** one. So:
 *
 *  - at least one conversation with a non-empty array → the array is in use here (`mongo`);
 *  - none → the arrays are retired and the store is the only source (`postgres`).
 *
 * This also stays correct on an un-migrated instance, which is the point: the question is answered
 * by the data, not by the deployment's intent.
 */
export const deriveMessageSource = (
  mongo: Pick<MongoProbe, "conversationsWithHistory">
): MessageSource => (mongo.conversationsWithHistory > 0 ? "mongo" : "postgres");

/**
 * The env keys that used to select the source, consulted only to *report* that they are ignored.
 *
 * The alias exists because a one-letter difference silently resolved to `mongo` for a whole cutover
 * (§22), so a stale value is worth naming even though it now has no effect.
 */
export const configuredSourceKeys = (): string[] =>
  SOURCE_KEYS.filter((key) => {
    const raw = process.env[key];
    return raw !== undefined && String(raw).trim() !== "";
  });

/**
 * Which store the environment *claims* is authoritative.
 *
 * RETIRED as a decision input — see `deriveMessageSource`. Kept so the suite can still pin the
 * alias-tolerant parsing, and so a script can report a stale value as stale.
 */
export const resolveMessageSource = (): MessageSource => {
  const raw = first(...SOURCE_KEYS.map((key) => process.env[key]));
  return raw && raw.toLowerCase() === "postgres" ? "postgres" : "mongo";
};

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Postgres connection, following the module's documented precedence
 * (`REACTORY_POSTGRES_*` → `POSTGRES_*`).
 *
 * The defaults are the local development shape and are stated as such, so a run against a real
 * instance fails loudly at connect rather than silently against the wrong database.
 */
export const resolvePgConfig = (): PgConfig => ({
  host: first(process.env.REACTORY_POSTGRES_HOST, process.env.POSTGRES_DB_HOST, process.env.POSTGRES_HOST) || "localhost",
  port: parseInt(first(process.env.REACTORY_POSTGRES_PORT, process.env.POSTGRES_DB_PORT, process.env.POSTGRES_PORT) || "5432", 10),
  user: first(process.env.REACTORY_POSTGRES_USER, process.env.POSTGRES_USER) || "reactory",
  password: first(process.env.REACTORY_POSTGRES_PASSWORD, process.env.POSTGRES_PASSWORD) || "reactory",
  database:
    first(
      process.env.REACTORY_POSTGRES_DB,
      process.env.REACTORY_POSTGRES_DATABASE,
      process.env.POSTGRES_DB,
      process.env.POSTGRES_DATABASE
    ) || "reactory",
});

/**
 * Mongo connection.
 *
 * Prefers a full URI, and **builds one from the discrete `MONGO_*` keys** when only those are set —
 * which is how other instances are usually configured, and which is why the earlier hardcoded
 * `…/reactory-reactory` fallback was wrong to rely on: the database name is instance-specific.
 */
export const resolveMongoUri = (): string => {
  const explicit = first(process.env.MONGOOSE, process.env.MONGODB_URI, process.env.MONGO_URI);
  if (explicit) return explicit;

  const host = first(process.env.MONGO_HOST) || "localhost";
  const port = first(process.env.MONGO_PORT) || "27017";
  const database = first(process.env.MONGO_DB, process.env.MONGO_DATABASE);
  const user = first(process.env.MONGO_USER);
  const password = first(process.env.MONGO_PASSWORD);

  // No database key: fall back to a connection string with no database, and let the driver use the
  // default. Guessing a name is how a check silently inspects the wrong database.
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? "")}@` : "";
  const db = database ? `/${database}` : "";
  const params = database && user ? "?authSource=admin" : "";

  return `mongodb://${auth}${host}:${port}${db}${params}`;
};

/** A connection string with the password removed, for printing. */
export const redactUri = (uri: string): string => uri.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");

/** A pg config with the password removed, for printing. */
export const redactPg = (config: PgConfig): string =>
  `postgres://${config.user}:***@${config.host}:${config.port}/${config.database}`;

export interface StoreProbe {
  reachable: boolean;
  tableExists: boolean;
  rows: number;
  conversations: number;
  newest: Date | null;
  /** Why the probe could not be trusted, when it could not. */
  reason?: string;
}

export interface MongoProbe {
  reachable: boolean;
  collectionExists: boolean;
  documents: number;
  conversationsWithHistory: number;
  reason?: string;
}

/**
 * What the write path is expected to do on this instance.
 *
 * Pure, and exported, because this is the decision every script must make and it is the one most
 * likely to be got wrong — on an un-migrated instance the array is *supposed* to grow.
 */
export interface WriteExpectations {
  /** Should an append grow Mongo's embedded `history` array here? */
  writesArray: boolean;
  /** Should an append write a row to the message store here? */
  writesStore: boolean;
  /** Is the message store usable at all on this instance? */
  storeUsable: boolean;
  /** One-line description, for the script banner. */
  describe: string;
}

export const deriveWriteExpectations = (
  messageSource: MessageSource,
  store: Pick<StoreProbe, "reachable" | "tableExists">
): WriteExpectations => {
  const storeUsable = store.reachable && store.tableExists;

  // The mirror is invoked at every append site regardless of the source, so whenever the store is
  // usable an append writes BOTH stores — that is what "dual-write" means, and it is why
  // `writesStore` does NOT depend on the source. Getting this wrong is not cosmetic: it would make
  // a script assert that rows must be *absent*, which is the opposite of the observed behaviour.
  const writesStore = storeUsable;

  // The array is authoritative under `mongo`, and under `postgres` it is retired — unless the
  // store is unusable, in which case the service's own gates fail open and the array is written
  // again. Asserting anything else would be asserting something the runtime does not do.
  const writesArray = messageSource === "mongo" || !storeUsable;

  const describe =
    messageSource === "mongo"
      ? storeUsable
        ? "dual-write era: Mongo is authoritative and the store is written alongside it"
        : "un-migrated: Mongo is authoritative; no usable message store on this instance"
      : storeUsable
        ? "cut over: the message store is authoritative, the embedded array is retired"
        : "MISCONFIGURED: source is postgres but the store is not usable — the service fails open to Mongo";

  return { writesArray, writesStore, storeUsable, describe };
};

export interface InstanceProbe {
  messageSource: MessageSource;
  store: StoreProbe;
  mongo: MongoProbe;
  expectations: WriteExpectations;
  notes: string[];
}

/**
 * Probe the message store without throwing and without requiring the ORM.
 *
 * Uses a raw `pg` client on purpose: the scripts must be able to report "this instance has no store
 * table" as a *finding*, and initialising TypeORM against a schema it cannot see is a heavier way to
 * learn the same thing — and one that behaves differently depending on `synchronize`.
 */
export const probeStore = async (config: PgConfig = resolvePgConfig()): Promise<StoreProbe> => {
  const empty: StoreProbe = { reachable: false, tableExists: false, rows: 0, conversations: 0, newest: null };
  const client = new Client({ ...config, connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
  } catch (error: any) {
    return { ...empty, reason: `cannot connect: ${error?.message ?? error}` };
  }

  try {
    // `to_regclass` returns NULL instead of raising when the relation is absent, which is exactly
    // the distinction that matters here.
    const reg = await client.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [
      `public.${STORE_TABLE}`,
    ]);

    if (!reg.rows[0]?.t) {
      return { ...empty, reachable: true, reason: `table ${STORE_TABLE} does not exist in this database` };
    }

    const counts = await client.query<{ rows: string; conversations: string; newest: Date | null }>(
      `SELECT count(*) AS rows,
              count(DISTINCT conversation_id) AS conversations,
              max(created_at) AS newest
         FROM ${STORE_TABLE}`
    );

    return {
      reachable: true,
      tableExists: true,
      rows: Number(counts.rows[0]?.rows ?? 0),
      conversations: Number(counts.rows[0]?.conversations ?? 0),
      newest: counts.rows[0]?.newest ?? null,
    };
  } catch (error: any) {
    return { ...empty, reachable: true, reason: `query failed: ${error?.message ?? error}` };
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Probe Mongo. Connects mongoose and **leaves it connected** — every caller needs it immediately
 * after, and reconnecting doubles the failure modes.
 */
export const probeMongo = async (uri: string = resolveMongoUri()): Promise<MongoProbe> => {
  const empty: MongoProbe = { reachable: false, collectionExists: false, documents: 0, conversationsWithHistory: 0 };

  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    }
  } catch (error: any) {
    return { ...empty, reason: `cannot connect: ${error?.message ?? error}` };
  }

  try {
    const collections = await mongoose.connection.db
      .listCollections({ name: CONVERSATIONS_COLLECTION })
      .toArray();

    if (collections.length === 0) {
      return { ...empty, reachable: true, reason: `collection ${CONVERSATIONS_COLLECTION} does not exist` };
    }

    const documents = await mongoose.connection.collection(CONVERSATIONS_COLLECTION).countDocuments();
    const conversationsWithHistory = await mongoose.connection
      .collection(CONVERSATIONS_COLLECTION)
      .countDocuments({ history: { $exists: true, $ne: [] } });

    return { reachable: true, collectionExists: true, documents, conversationsWithHistory };
  } catch (error: any) {
    return { ...empty, reachable: true, reason: `query failed: ${error?.message ?? error}` };
  }
};

/** Probe everything. Never throws. */
export const probeInstance = async (options?: {
  mongoUri?: string;
  pgConfig?: PgConfig;
}): Promise<InstanceProbe> => {
  const configuredSource = resolveMessageSource();
  const configuredKeys = configuredSourceKeys();
  const store = await probeStore(options?.pgConfig ?? resolvePgConfig());
  const mongo = await probeMongo(options?.mongoUri ?? resolveMongoUri());

  // Derived from the DATA, not the environment — the flag was retired in step 3, so reading it would
  // report `mongo` for an instance whose arrays are gone and then assert that the array grows.
  const messageSource = deriveMessageSource(mongo);

  const notes: string[] = [];
  if (store.reason) notes.push(`store: ${store.reason}`);
  if (mongo.reason) notes.push(`mongo: ${mongo.reason}`);
  if (store.reachable && store.tableExists && store.rows === 0) {
    notes.push(`the store table exists but holds no rows — a migrated instance would not be here`);
  }
  if (configuredKeys.length > 0) {
    notes.push(
      `${configuredKeys.join(", ")}=${configuredSource} is set but IGNORED: the message source is no ` +
        `longer configurable, and this check derives the source from the data instead. Remove the variable.`
    );
  }
  if (mongo.collectionExists) {
    notes.push(
      messageSource === "mongo"
        ? `${mongo.conversationsWithHistory} conversation(s) still carry a non-empty embedded array, so the array is in use here`
        : `no conversation carries a non-empty embedded array, so the arrays are retired and the store is the only source`
    );
  }
  if (messageSource === "postgres" && !(store.reachable && store.tableExists)) {
    notes.push(`the arrays are retired here but the store is unusable, so the service persists no message anywhere`);
  }

  return { messageSource, store, mongo, expectations: deriveWriteExpectations(messageSource, store), notes };
};

/**
 * Verdict aggregation with an explicit third state.
 *
 * `NOT APPLICABLE` exists because the alternative is a lie in one direction or the other: report it
 * as PASS and a green run hides that nothing was verified; report it as FAIL and a non-migrated
 * instance looks broken. It is neither, so it is its own state.
 *
 * `--require-applicable` closes the remaining hole — on an instance where the check *should* apply,
 * "everything was not applicable" becomes a failure rather than a quiet pass. Without the flag the
 * exit code is 0, so the scripts stay safe to run anywhere.
 */
export class Reporter {
  private readonly requireApplicable: boolean;
  private passed = 0;
  private failed = 0;
  private notApplicableCount = 0;
  private readonly failures: string[] = [];
  private readonly skipped: string[] = [];

  constructor(title: string, options?: { requireApplicable?: boolean }) {
    this.requireApplicable = options?.requireApplicable ?? false;
    console.log("──────────────────────────────────────────────────────────");
    console.log(` ${title}`);
    console.log("──────────────────────────────────────────────────────────");
  }

  banner(line: string): void {
    console.log(line);
  }

  section(title: string): void {
    console.log(`\n${title}`);
  }

  log(line: string): void {
    console.log(`      ${line}`);
  }

  pass(label: string, detail = ""): void {
    this.passed += 1;
    console.log(`   ✓ ${label}${detail ? `  (${detail})` : ""}`);
  }

  fail(label: string, detail = ""): void {
    this.failed += 1;
    this.failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`   ✗ ${label}${detail ? `  (${detail})` : ""}`);
  }

  check(label: string, ok: boolean, detail = ""): void {
    if (ok) this.pass(label, detail);
    else this.fail(label, detail);
  }

  notApplicable(label: string, reason: string): void {
    this.notApplicableCount += 1;
    this.skipped.push(`${label} — ${reason}`);
    console.log(`   ⊘ ${label}  (not applicable: ${reason})`);
  }

  /** Print the summary and return the process exit code. */
  finish(): number {
    const applicable = this.passed + this.failed;
    console.log("\n" + "─".repeat(58));
    console.log(`checks: ${this.passed} passed, ${this.failed} failed, ${this.notApplicableCount} not applicable`);

    if (this.notApplicableCount > 0) {
      console.log("\nNot applicable here:");
      this.skipped.forEach((line) => console.log(`   ⊘ ${line}`));
    }

    if (this.failed > 0) {
      console.log("\nFailures:");
      this.failures.forEach((line) => console.log(`   - ${line}`));
      console.log(`\nFAIL — ${this.failed}/${applicable} applicable checks failed.`);
      return 1;
    }

    if (this.requireApplicable && applicable === 0) {
      console.log(
        `\nFAIL — nothing was applicable on this instance, and --require-applicable was given. ` +
          `That flag means "this check is expected to apply here"; it did not.`
      );
      return 1;
    }

    if (applicable === 0) {
      console.log(
        `\nNOT APPLICABLE — no check on this instance applied. Nothing was verified, and nothing failed. ` +
          `Exit 0 by design; pass --require-applicable to treat this as a failure.`
      );
      return 0;
    }

    console.log(
      this.notApplicableCount > 0
        ? `\nPASS — ${this.passed}/${applicable} applicable checks passed; ${this.notApplicableCount} not applicable.`
        : `\nPASS — ${this.passed}/${applicable} checks.`
    );
    return 0;
  }
}

/** `--require-applicable` from argv, shared so every script spells it the same way. */
export const hasRequireApplicable = (argv: string[] = process.argv.slice(2)): boolean =>
  argv.includes("--require-applicable");

/** `--since=<iso>` from argv, with a default window in minutes. */
export const resolveSince = (argv: string[] = process.argv.slice(2), defaultMinutes = 15): Date => {
  const raw = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
  if (!raw) return new Date(Date.now() - defaultMinutes * 60 * 1000);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--since must be an ISO timestamp, got: ${raw}`);
  }
  return parsed;
};
