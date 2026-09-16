import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ObjectId } from 'mongodb';
import OpenAI from "openai"
import path from 'path';
import { MetaSchema } from '@reactory/server-modules/reactory-core/models/shared';
import { id } from 'schema/reflection';
import { MacroComponentDefinition, MacroToolDefinition, ToolApprovalMode } from '../ai/openai/types/chat';
import { McpSession } from '../types/model.types';
// Removed incorrect import as 'ChatCompletionResponseMessage' is not exported by 'openai'

/**
 * Descriptive metadata for a conversation, surfaced in the chat history.
 *
 * The AI agent maintains these via the `updateChatData` tool so a session can
 * be recognised at a glance: a human readable title, a short summary of what
 * the conversation is about, discovery tags, and a status icon with a colour
 * code (e.g. green = done, amber = in progress, red = blocked).
 */
export interface ConversationMeta { 
  tags?: string[]
  summary?: string
  title: string
  /** Material icon name describing the conversation status (e.g. "check_circle"). */
  icon?: string
  /** Hex colour code used to tint the status icon (e.g. "#2e7d32"). */
  color?: string
}

export type ChatHistoryItem = OpenAI.Chat.Completions.ChatCompletionMessage |
  OpenAI.Chat.ChatCompletionMessageParam;

// Add more specific types for other providers if needed
export type ValidProviderResponseTypes = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Represents the execution status of a tool call.
 */
export type ReactorToolCallStatus = 'pending' | 'running' | 'success' | 'error';

/**
 * Represents a single tool call requested by the AI,
 * enriched with execution status when loaded from history.
 */
export type ReactorToolCallEntry = {
  id: string
  type?: string
  function?: {
    name: string
    arguments?: string
  }
  /** Execution status derived from correlating tool results/errors in history */
  status?: ReactorToolCallStatus
};

export type ReactorToolResult = {
  id?: string
  tool_call_id?: string
  name?: string
  role?: 'tool'  
  content: any
  result?: any
  timestamp?: Date
  [key: string]: any
};

export type ReactorToolError = {
  id?: string
  name?: string
  error?: string
  timestamp?: Date
};

export type ReactorConversationHistoryItem = ChatHistoryItem & {
  id: string | ObjectId
  // Original content of the message by the provider
  response?: ValidProviderResponseTypes;
  rating?: number
  component?: string
  timestamp: Date
  tool_name?: string
  tool_args?: any
  tool_call_id?: string
  tool_calls?: ReactorToolCallEntry[]
  tool_results?: ReactorToolResult[]
  tool_errors?: ReactorToolError[]
  /** Reasoning/thinking content from models with extended thinking (OpenAI o1/o3, Anthropic, Gemini) */
  thinking?: string
  /**
   * Provider-native reasoning content blocks, stored verbatim.
   *
   * Anthropic requires the thinking blocks that preceded a tool_use to be
   * replayed unchanged (signature included) on the assistant turn carrying that
   * tool_use when the tool results are sent back; the flattened `thinking`
   * string above cannot satisfy that. Only populated for providers that need it.
   */
  thinking_blocks?: any[]
  /** Generated images from image-capable models */
  images?: Array<{ url?: string; b64_json?: string; mimeType?: string }>
}

export type ReactorConversationHistory = ReactorConversationHistoryItem[];

export interface ReactorConversationDocument {
  _id: ObjectId
  // The bot persona id
  personaId: string
  // The date the conversation was started
  started: Date,
  // The model id used for the conversation
  modelId: string
  // The provider id used for the conversation (e.g. "openai", "google", "xai")
  providerId?: string
  // The user associated with the conversation
  user: Reactory.Models.IUser
  // The meta data for the conversation
  meta: Reactory.Models.IRecordMeta<ConversationMeta>
  /**
   * A short, human readable title for the conversation. Auto-generated from
   * the user's first message, but the agent may override it (and the fields
   * below) at any point via the `updateChatData` tool.
   */
  title?: string
  /** A short summary (1-2 sentences) of what the conversation is about. */
  summary?: string
  /** Free-form tags for grouping and discovery in the chat history. */
  tags?: string[]
  /** Material icon name describing the conversation status. */
  icon?: string
  /** Hex colour code used to tint the status icon. */
  color?: string
  // The history of the conversation
  history: ReactorConversationHistory
  // The variables for the conversation
  vars: {
    [key: string]: any
  }
  // The SSE session id for the conversation 
  sseSessionId?: string
  // The date the conversation was created
  created: Date
  // The date the conversation was last
  updated: Date
  // Indicates whether the conversation is currently processing a message/tools
  processing?: boolean
  // The tool approval mode for the conversation
  toolApprovalMode: ToolApprovalMode
  // The maximum number of auto tool call iterations before pausing for user confirmation
  maxToolIterations?: number
  // The macros used in the conversation
  macros?: Partial<MacroComponentDefinition<any>>[]
  // The tools used in the conversation
  tools?: Partial<MacroToolDefinition>[]
  // The MCP sessions associated with the conversation
  mcpSessions?: McpSession[]
  // The estimated token count for the conversation
  tokenCount?: number
  // The maximum number of tokens this chat should be
  maxTokens?: number
  // The truncated history - messages removed to stay within token limits
  truncatedHistory?: ReactorConversationHistory
  // The user files attached to this conversation session
  files: Reactory.Models.IReactoryFile[]
  /**
   * Folders the user pinned to this session (paths under the user file root or absolute on desktop).
   */
  pinnedFolders?: { name: string; path: string }[]
  // The persisted side panel state for this conversation
  sidePanelState?: {
    items: {
      id: string;
      componentFqn: string;
      title: string;
      type: 'component' | 'form';
      props?: Record<string, any>;
      addedAt: Date;
      addedBy?: string;
    }[];
    activeItemId?: string;
    isOpen: boolean;
  } | null;
  // Optional reference to a parent session that provided context for this session
  parentSessionId?: string
  /**
   * What the conversation is being used for: "standalone", "workflow",
   * "content", "form", or any application defined string.
   *
   * Conversations are scoped by this, so a chat opened alongside a content
   * editor never resumes or lists a chat from somewhere else in the product.
   * Defaults to "standalone", which is the plain chat experience.
   */
  use_case?: string
  /**
   * Arbitrary links from this conversation to things outside it — the workflow
   * it belongs to, the content slug it is editing, a related conversation.
   *
   * Kept as a generic name/value/type triple rather than dedicated columns so
   * a new kind of association does not need a schema change.
   */
  edges?: {
    name: string;
    value: string;
    edge_type: string;
  }[]
  // Virtual: resolved session folder path (not persisted to DB)
  readonly sessionFolder?: string
  // Virtual: child conversations spawned from this session (sub-agent delegations)
  readonly chats?: ReactorConversationDocument[]
}



export type ReactorConversationDocumentStatics = {
  new(): ReactorConversation
}
export type ReactorConversation = ReactorConversationDocument & ReactorConversationDocumentStatics;

const ReactorConversationHistorySchema = new Schema({
  id: ObjectId,
  response: {},
  content: { type: Schema.Types.Mixed, default: null },
  refusal: String,
  thinking: String,
  thinking_blocks: { type: [Schema.Types.Mixed], default: undefined },
  images: { type: [Schema.Types.Mixed], default: undefined },
  component: String,
  rating: Number,
  role: String,
  annotations: [{}],
  audio: {},
  tool_name: String,
  tool_args: {},
  tool_call_id: String,
  tool_calls: [{}],
  tool_results: [{}],
  tool_errors: [{}],
  timestamp: {
    type: Date,
    default: () => { return new Date() }
  },
});

const ReactorConversationSchema = new Schema({
  // the bot id is the persona id we are using for the conversation
  personaId: {
    type: String,
    required: true,
    default: 'Reactor',
  },
  started: {
    type: Date,
    required: true,
    default: () => { return new Date() }
  },
  modelId: {
    type: String,
    required: true,
    default: process.env.OPENAI_DEFAULT_MODEL_ID || 'grok-2-latest',
  },
  providerId: {
    type: String,
    default: null,
  },
  user: {
    type: ObjectId,
    ref: 'User',
  },
  meta: MetaSchema,
  history: [ReactorConversationHistorySchema],
  vars: {},
  sseSessionId: {
    type: String,
    default: null,
  },
  macros: {
    type: [Object],
    default: [],
  },
  tools: {
    type: [Object],
    default: [],
  },
  mcpSessions: {
    type: [Object],
    default: [],
  },
  created: {
    type: Date,
    default: () => { return new Date() }
  },
  updated: {
    type: Date,
    default: () => { return new Date() }
  },
  processing: {
    type: Boolean,
    default: false,
  },
  toolApprovalMode: {
    type: String,
    enum: Object.values(ToolApprovalMode),
    default: ToolApprovalMode.PROMPT,
  },
  // The maximum number of auto tool call iterations before pausing for user confirmation
  maxToolIterations: {
    type: Number,
    default: null,
    min: 1,
  },
  // The estimated token count for the conversation
  tokenCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  // The maximum number of tokens this chat should be
  maxTokens: {
    type: Number,
    default: null,
    min: 0,
  },
  files: {
    type: [ObjectId],
    ref: 'ReactoryFile',
    default: [],
  },
  pinnedFolders: {
    type: [{ name: String, path: String }],
    default: [],
  },
  // The persisted side panel state for this conversation
  sidePanelState: {
    type: {
      items: [{
        id: String,
        componentFqn: String,
        title: String,
        type: { type: String, enum: ['component', 'form'] },
        props: { type: Schema.Types.Mixed, default: null },
        addedAt: Date,
        addedBy: String,
      }],
      activeItemId: String,
      isOpen: { type: Boolean, default: false },
    },
    default: null,
  },
  // The truncated history - messages removed to stay within token limits
  truncatedHistory: {
    type: [ReactorConversationHistorySchema],
    default: [],
  },
  // A short title for the conversation, generated from the user's first message
  title: {
    type: String,
    default: null,
  },
  // A short summary (1-2 sentences) of what the conversation is about.
  summary: {
    type: String,
    default: null,
  },
  // Free-form tags for grouping and discovery in the chat history.
  tags: {
    type: [String],
    default: [],
  },
  // Material icon name describing the conversation status.
  icon: {
    type: String,
    default: null,
  },
  // Hex colour code used to tint the status icon.
  color: {
    type: String,
    default: null,
  },
  // Optional reference to a parent session that provided context for this session
  parentSessionId: {
    type: String,
    default: null,
    index: true,
  },
  // What the conversation is being used for. Indexed because every list and
  // resume query filters on it.
  use_case: {
    type: String,
    default: 'standalone',
    index: true,
  },
  // Links from this conversation to workflows, content, other conversations.
  edges: {
    type: [{
      _id: false,
      name: { type: String, required: true },
      value: { type: String, required: true },
      edge_type: { type: String, required: true },
    }],
    default: [],
  },
});

// Resuming a conversation looks it up by user, persona and use case together,
// so the three are indexed as one.
ReactorConversationSchema.index({ user: 1, personaId: 1, use_case: 1, updated: -1 });
// Finding the conversation attached to a given workflow or content item.
ReactorConversationSchema.index({ 'edges.edge_type': 1, 'edges.value': 1 });

ReactorConversationSchema.virtual('sessionFolder').get(function () {
  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!dataRoot) return undefined;

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

  const rawUser = this.user;
  const userId = sanitize(
    (rawUser?._id ?? rawUser)?.toString() || ''
  );
  const personaId = sanitize(this.personaId || '');
  const conversationId = sanitize(this._id?.toString() || '');

  if (!userId || !personaId || !conversationId) return undefined;

  return path.join(dataRoot, 'profiles', userId, 'chats', personaId, conversationId);
});

ReactorConversationSchema.virtual('chats', {
  ref: 'ReactorConversation',
  localField: '_id',
  foreignField: 'parentSessionId',
  justOne: false,
});

ReactorConversationSchema.set('toJSON', { virtuals: true });
ReactorConversationSchema.set('toObject', { virtuals: true });

/**
 * ---------------------------------------------------------------------------------------------
 * Phase 3c step 1 — the embedded `history` arrays stop being persisted
 * ---------------------------------------------------------------------------------------------
 *
 * The Postgres message store is authoritative (unconditionally since Phase 3c step 3 retired the
 * embedded `history` / `truncatedHistory` arrays are still maintained **in memory** — every
 * caller keeps using them unchanged — but they are no longer **persisted**. Two reasons, both
 * observed rather than assumed:
 *
 *  1. `$unset history` cannot be durable while the array is still written. In the §43.4 pilot the
 *     field was removed, the model still answered from the message store — and the array **came
 *     back** holding exactly the latest turn's messages, because the ordinary `$push` append path
 *     was still writing it. The cutover would have looked finished while not being finished.
 *  2. A second copy of the transcript written by some paths and not others is worse than no second
 *     copy: it disagrees silently, and the disagreement is only found by whoever trusts it.
 *
 * This is the single choke point (§44.2, Option B): one pair of hooks covers every write site in
 * `ReactorConversationService`. Because it removes the arrays from the *payload* — never from the
 * document — every in-memory use of `history` is untouched, which is the point: the risk here was
 * never the number of sites, it was the implicit in-memory assumption at each of them.
 *
 * Deliberate exceptions, each with a reason, each recorded in the design log §47:
 *
 *  - **New documents are exempt from the `save()` strip.** A brand-new conversation's array is
 *    created deliberately (the persona system prompt), and the ephemeral compaction-summary
 *    conversation in `generateCompactionSummary` is read back through the Mongo array *because it
 *    has no rows in the message store*. Stripping a new document would empty the model's context
 *    for that call. The array a new document carries is bounded and small.
 *  - **Whole-array rewrites are reported, not stripped.** `truncateConversationHistory` and
 *    `compactConversationHistory` replace the arrays wholesale and have no message-store
 *    counterpart yet — compaction must also insert a summary *before* the kept messages, which
 *    needs a `seq` shift (§47 step 1b). Stripping them without that counterpart would turn
 *    compaction into a silent no-op on the authoritative store, so they are permitted and logged
 *    loudly instead of half-applied.
 *
 * Only keys **named exactly** `history` / `truncatedHistory` are touched. That is load-bearing:
 * `$push: { "history.$.tool_results": … }` backfills a sub-array of an *existing* item and is never
 * a new row, so name-equality leaves those two backfills working by construction, where a
 * subtree-wise "remove anything under history" rule would silently break them.
 */
const EMBEDDED_HISTORY_PATHS = ["history", "truncatedHistory"] as const;

const PHASE3C_WRITE_PREFIX = "[reactor] Phase3c write-path:";

/**
 * Whether the Postgres message store is authoritative for this process.
 *
 * Resolved through the same resolver the read path uses, so one environment variable decides both
 * directions and they cannot drift. Required lazily because the model layer must not statically
 * depend on services, and guarded because a failure here must degrade to today's behaviour —
 * writing the array — rather than to a write that silently drops the transcript.
 */
/**
 * Warn — once per process — that a `mongo` source can no longer see the whole conversation.
 *
 * This is the second half of the "remove the trap" decision (§45.1): the write path stopped
 * persisting the embedded array, so from that moment the array is authoritative only for messages
 * written **before** the conversion. An operator who flips back to `mongo` expecting a clean
 * rollback gets a transcript quietly missing everything written since — no error, just a short
 * history. That silence is the hazard this warns about.
 *
 * Phrased as a condition rather than a fault, deliberately: on an instance that was never migrated
 * the array genuinely *is* authoritative, and claiming otherwise would be a false alarm. It is
 * louder when a Postgres DataSource is also initialised in this process, because "a message store
 * exists here and reads are pointed away from it" is the configuration worth shouting about.
 *
 * Fired from the write hooks (so it carries the context of a real write) and gated to once per
 * process (so it does not become noise).
 */
let mongoStalenessWarned = false;

export const warnIfMongoSourceMayBeStale = (): void => {
  if (mongoStalenessWarned) return;
  mongoStalenessWarned = true;

  let storeConfigured = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReactorPostgresDataSource } = require("../models") as { ReactorPostgresDataSource: any };
    storeConfigured = ReactorPostgresDataSource?.isInitialized === true;
  } catch {
    storeConfigured = false;
  }

  const because =
    "the write path stopped persisting the embedded history array when the message store became " +
    "authoritative, so this array is only authoritative for messages written BEFORE the cutover";

  // eslint-disable-next-line no-console
  console.warn(
    storeConfigured
      ? "[reactor] Phase3 write-path: SOURCE IS mongo WHILE A MESSAGE STORE IS CONFIGURED. " +
          because +
          ". Reads served from here will be silently incomplete — restore Mongo from the pre-3c " +
          "backup before relying on this source. Note that the message source is no longer " +
          "configurable, so setting REACTOR_MESSAGE*_SOURCE will not bring those messages back."
      : "[reactor] Phase3 write-path: source is mongo. If this instance has already been cut " +
          "over, " +
          because +
          ". On an instance that has never been migrated this is expected."
  );
};

/** Test seam: the warning is once-per-process, so a suite must be able to re-arm it. */
export const __resetMongoStalenessWarningForTests = (): void => {
  mongoStalenessWarned = false;
};
export const isMessageStoreAuthoritative = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveMessagesSource } = require("../services/reactor/ReactorConversationMessageService") as {
      resolveMessagesSource: () => string;
    };
    return resolveMessagesSource() === "postgres";
  } catch {
    return false;
  }
};

/**
 * Strip the embedded-array **append** keys from one update document, in place.
 *
 * Returns the paths it removed. A whole-array rewrite is passed to `onReplacement` instead of
 * being removed, so the caller can report that something still writes Mongo — silence is the
 * failure mode this change exists to remove.
 */
export const stripEmbeddedHistoryAppends = (
  update: Record<string, any>,
  onReplacement: (path: string) => void
): string[] => {
  const paths = EMBEDDED_HISTORY_PATHS;
  const removed: string[] = [];

  const handle = (op: string, container: Record<string, any>) => {
    for (const path of paths) {
      if (!Object.prototype.hasOwnProperty.call(container, path)) continue;

      if (op === "$push" || op === "$addToSet") {
        // The append path this change exists to stop.
        delete container[path];
        removed.push(op + "." + path);
      } else if (op === "bare" || op === "$set") {
        // A whole-array rewrite, not an append. Reported, not stripped.
        onReplacement(op === "bare" ? path : op + "." + path);
      }
    }
  };

  // A bare (operator-less) update: { history: [...], tokenCount: n }
  handle("bare", update);

  for (const op of Object.keys(update)) {
    if (op.indexOf("$") !== 0) continue;
    const payload = update[op];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (op === "$push" || op === "$addToSet" || op === "$set") handle(op, payload);
  }

  return removed;
};

/**
 * Drop operator objects that stripping has emptied, and keep what remains a valid update.
 * MongoDB rejects an empty update document and an empty `$set`, so a site whose update was *only*
 * a `history` push would otherwise start throwing after the strip.
 */
export const normaliseStrippedUpdate = (update: Record<string, any>): void => {
  for (const op of Object.keys(update)) {
    if (op.indexOf("$") !== 0) continue;
    const payload = update[op];
    if (payload && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0) {
      delete update[op];
    }
  }

  if (Object.keys(update).length === 0) {
    update.$set = { updated: new Date() };
  }
};

/**
 * Append path: `findOneAndUpdate`. Covers all 17 item-appending sites plus the two
 * `history.$.tool_results` backfills, which name-equality leaves alone.
 */
ReactorConversationSchema.pre("findOneAndUpdate", function (next) {
  if (!isMessageStoreAuthoritative()) {
    warnIfMongoSourceMayBeStale();
    return next();
  }

  const query: any = this;
  const raw = typeof query.getUpdate === "function" ? query.getUpdate() : query._update;
  const entries: Record<string, any>[] = Array.isArray(raw)
    ? (raw.filter((entry: any) => entry && typeof entry === "object") as Record<string, any>[])
    : raw && typeof raw === "object"
      ? [raw as Record<string, any>]
      : [];

  const removed: string[] = [];
  const replacements: string[] = [];

  entries.forEach((entry) => {
    removed.push(...stripEmbeddedHistoryAppends(entry, (path) => replacements.push(path)));
    normaliseStrippedUpdate(entry);
  });

  if (removed.length > 0) {
    // Recorded on the query so a later check can *prove* the choke point fired rather than
    // assume it — the failure mode being guarded against is a hook that silently does nothing.
    query.__embeddedHistoryAppendsStripped = removed;
  }

  if (replacements.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      PHASE3C_WRITE_PREFIX +
        " a whole-array rewrite is still persisted to Mongo (" +
        replacements.join(", ") +
        "). That is truncation/compaction, which has no message-store counterpart yet — see design log §47 step 1b. Reads are unaffected; this conversation's array is simply not retired."
    );
  }

  next();
});

/**
 * Save path: here the document *is* the payload, so the arrays are cleared from the modified set
 * rather than deleted. `unmarkModified` leaves the values in place, which is why no
 * snapshot/restore is needed and why the caller's in-memory document is unchanged.
 *
 * Verified against `doc.$__delta()` before this was written: a push, a splice and a subdocument
 * mutation all mark only the array path, and clearing the modified paths under the prefixes
 * removes them from the delta entirely (probe: /tmp/history-choke-probe.js, design log §47).
 */
export const stripEmbeddedHistoryFromSave = (doc: any): string[] => {
  if (!doc || doc.isNew) return [];

  const tracked: string[] = typeof doc.modifiedPaths === "function" ? doc.modifiedPaths() : [];
  const modifiedArrays = tracked.filter((path) =>
    EMBEDDED_HISTORY_PATHS.some((prefix) => path === prefix || path.indexOf(prefix + ".") === 0)
  );

  if (modifiedArrays.length === 0) return [];

  modifiedArrays.forEach((path) => doc.unmarkModified(path));
  // Clearing a sub-path can leave an ancestor marked; clearing the prefixes as well is
  // belt-and-braces and was verified to yield a delta containing neither array.
  EMBEDDED_HISTORY_PATHS.forEach((prefix) => doc.unmarkModified(prefix));

  return modifiedArrays;
};

ReactorConversationSchema.pre("save", function (next) {
  if (!isMessageStoreAuthoritative()) {
    warnIfMongoSourceMayBeStale();
    return next();
  }
  stripEmbeddedHistoryFromSave(this);
  next();
});

const ReactorConversationModelName = 'ReactorConversation';
const ReactorConversationModel = mongoose.model<ReactorConversationDocument>(ReactorConversationModelName, ReactorConversationSchema, 'reactor_conversations');

// Add unique indexes to prevent duplicate conversations
ReactorConversationSchema.index(
  { personaId: 1, user: 1, started: 1 }, 
  { 
    unique: true, 
    partialFilterExpression: { 
      started: { $exists: true },
      personaId: { $exists: true },
      user: { $exists: true }
    }
  }
);

// Add unique index on sseSessionId to prevent duplicates
ReactorConversationSchema.index(
  { sseSessionId: 1 }, 
  { 
    unique: true, 
    sparse: true,
    partialFilterExpression: { sseSessionId: { $exists: true, $ne: null } }
  }
);

export type TReactorConversationDocument = mongoose.Document & ReactorConversationDocument;
export type TReactorConversationModel = typeof ReactorConversationModel;
export const ReactorConversationModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorConversationModel> = { 
  name: 'ReactorConversationModel',
  nameSpace: 'reactor',
  description: 'Reactor Conversation Model',
  version: '1.0.0',
  component: ReactorConversationModel,
  features: [
    {
      feature: 'id',
      description: 'Reactor Conversation Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'id',
    },
    {
      feature: 'botId',
      description: 'Reactor Conversation Bot Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'botId',
    },
    {
      feature: 'started',
      description: 'Reactor Conversation Start Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'started',
    },
    {
      feature: 'modelId',
      description: 'Reactor Conversation Model Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'modelId',
    },
    {
      feature: 'user',
      description: 'Reactor Conversation User',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'user',
    },
    {
      feature: 'meta',
      description: 'Reactor Conversation Meta',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'meta',
    },
    {
      feature: 'history',
      description: 'Reactor Conversation History',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'history',
    },
    {
      feature: 'created',
      description: 'Reactor Conversation Created Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'created',
    },
    {
      feature: 'updated',
      description: 'Reactor Conversation Updated Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'updated',
    },
    {
      feature: 'tokenCount',
      description: 'Reactor Conversation Token Count',
      featureType: Reactory.FeatureType.number,
      action: ['get', 'set'],
      stem: 'tokenCount',
    },
    {
      feature: 'maxTokens',
      description: 'Reactor Conversation Maximum Tokens',
      featureType: Reactory.FeatureType.number,
      action: ['get', 'set'],
      stem: 'maxTokens',
    },
    {
      feature: 'truncatedHistory',
      description: 'Reactor Conversation Truncated History',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'truncatedHistory',
    },
  ]
}

export default ReactorConversationModel;