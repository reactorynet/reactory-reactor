#!/usr/bin/env node
/**
 * New-chat reuse guard (WRITES throwaways, then deletes them).
 *
 * "New chat" may legitimately re-use a **blank** conversation, so that opening and abandoning a chat
 * does not leave empty conversations behind. The question it must answer is "is this conversation
 * blank?", and it used to answer it from the embedded Mongo `history` array. After the write-path
 * cutover that array is no longer written, so the predicate is permanently true for every
 * post-cutover conversation — including ones holding hundreds of messages. `new chat` then returned
 * the same conversation forever, dropping the user into an existing transcript.
 *
 * The fix asks the message store instead. This guard tests the *behaviour*, not the code:
 *
 *   for a conversation that LOOKS blank in Mongo but HOLDS content in the store,
 *   `getNewConversation` must not return it.
 *
 * A data-only check would be wrong here: after the cutover these conversations look blank by design,
 * so the shape itself is normal and cannot be asserted against. What must hold is that the service
 * does not act on it.
 *
 * Usage:
 *   ... pilotNewChatReuse.ts [--keep] [--require-applicable]
 *
 * Deletes any conversation it creates; `--keep` leaves them for inspection. It never modifies an
 * existing conversation beyond the `started`/`updated` stamp that a real "New chat" click performs.
 */
import "reflect-metadata";
import mongoose from "mongoose";
import ReactorConversationService from "../services/reactor/ReactorConversationService";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
import {
  probeInstance,
  redactPg,
  resolveMongoUri,
  resolvePgConfig,
  hasRequireApplicable,
  Reporter,
  CONVERSATIONS_COLLECTION,
} from "./lib/instanceProbe";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

/**
 * Exactly the predicate `getNewConversation` starts from when it looks for a reusable conversation,
 * before the message store excludes the ones that already hold a transcript.
 *
 * The `$exists: false` arm must match the method exactly: a document whose array was retired carries
 * no field at all, and `{ $size: 0 }` does NOT match a missing field — so the guard would report a
 * failure that is really a stale predicate.
 */
const LOOKS_BLANK: Record<string, any> = {
  _id: { $ne: null },
  $or: [
    { history: { $exists: false } },
    { history: { $size: 0 } },
    { history: { $size: 1 }, "history.0.role": "system" },
  ],
};

const run = async () => {
  const reporter = new Reporter("New-chat reuse: a conversation with content must not be re-used as blank", {
    requireApplicable: hasRequireApplicable(args),
  });

  const pgConfig = resolvePgConfig();
  const probe = await probeInstance({ pgConfig, mongoUri: resolveMongoUri() });

  reporter.banner(` WRITES throwaways, then deletes them`);
  reporter.banner(` postgres : ${redactPg(pgConfig)}`);
  reporter.banner(` instance : ${probe.expectations.describe}`);

  if (!probe.mongo.reachable || !probe.mongo.collectionExists) {
    reporter.notApplicable("new-chat reuse", "the conversations collection is not reachable here");
    process.exit(reporter.finish());
  }
  if (!(probe.store.reachable && probe.store.tableExists)) {
    reporter.notApplicable("new-chat reuse", "no message store on this instance");
    process.exit(reporter.finish());
  }

  const { ReactorPostgresDataSource } = require("../models");
  if (!ReactorPostgresDataSource.isInitialized) await ReactorPostgresDataSource.initialize();

  const store = new ReactorConversationMessageService();
  if (!store.isAvailable()) {
    reporter.notApplicable("new-chat reuse", "the message store is not available in this process");
    process.exit(reporter.finish());
  }

  const collection = mongoose.connection.collection(CONVERSATIONS_COLLECTION);

  const candidates = await collection
    .find(LOOKS_BLANK)
    .project({ _id: 1, personaId: 1, user: 1, use_case: 1, history: 1 })
    .limit(50)
    .toArray();

  const withContent = await store.conversationsWithContent(
    candidates.map((candidate: any) => String(candidate._id))
  );

  const dangerous = candidates.filter((candidate: any) => withContent.has(String(candidate._id)));

  reporter.section(`Conversations that look blank in Mongo : ${candidates.length}`);
  reporter.section(`…of those, holding store content      : ${dangerous.length}`);

  if (dangerous.length === 0) {
    // Two possible readings, and they are different. If nothing looks blank at all, the check has no
    // subject. If things look blank but none holds content, that is a genuine pass.
    if (candidates.length === 0) {
      reporter.notApplicable(
        "new-chat reuse",
        "no conversation currently looks blank, so there is nothing to re-use and nothing to check"
      );
    } else {
      reporter.pass(
        "every conversation that looks blank really is blank",
        `${candidates.length} candidate(s) checked, store content in 0`
      );
    }
    await mongoose.disconnect();
    process.exit(reporter.finish());
  }

  const before = new Set(
    (await collection.find({}, { projection: { _id: 1 } }).toArray()).map((doc: any) => String(doc._id))
  );

  for (const candidate of dangerous) {
    const id = String(candidate._id);
    const stats = await store.countForConversation(id, { includeArchived: true });

    const svc: any = Object.create(ReactorConversationService.prototype);
    const noop = (): void => undefined;
    svc.context = {
      user: { _id: candidate.user },
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      log: noop,
    };
    svc.sessionLog = (): void => undefined;

    let returned: string | null = null;
    let failure = "";
    try {
      const conversation = await svc.getNewConversation(
        { id: candidate.personaId, name: candidate.personaId },
        { use_case: candidate.use_case || "standalone" }
      );
      returned = conversation ? String(conversation._id) : null;
    } catch (error: any) {
      failure = error?.message ?? String(error);
    }

    reporter.check(
      `${id} (store rows=${stats}, looks blank) is NOT handed back as a new chat`,
      !failure && returned !== null && returned !== id,
      failure ? `threw: ${failure}` : `returned ${returned}`
    );
  }

  // Clean up anything this guard created. Existing conversations are left alone (reuse only stamps
  // started/updated, which is what a real click does).
  if (KEEP) {
    reporter.banner("   --keep given; created conversations left in place");
  } else {
    const after = await collection.find({}, { projection: { _id: 1 } }).toArray();
    const created = after.map((doc: any) => String(doc._id)).filter((id: string) => !before.has(id));
    for (const id of created) {
      await store.deleteForConversation(id);
      await collection.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    }
    // A real assertion, not a vacuous one: the created conversations must actually be gone, with
    // their rows. (An earlier version of this line read `created.length === 0 || true`, which can
    // never fail — the exact anti-pattern this project keeps finding in its own checks.)
    let stillPresent = 0;
    for (const id of created) {
      const doc = await collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
      const rows = await store.countForConversation(id, { includeArchived: true });
      if (doc || rows > 0) stillPresent += 1;
    }
    reporter.check(
      "conversations created by this guard were removed",
      stillPresent === 0,
      created.length === 0 ? "none were created" : `removed ${created.length}, still present ${stillPresent}`
    );
  }

  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`New-chat reuse guard failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
