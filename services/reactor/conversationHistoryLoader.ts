import ReactorConversationMessageService, {
  resolveMessagesSource,
} from "./ReactorConversationMessageService";

/**
 * Resolve a conversation's ACTIVE history for use as **model context**.
 *
 * Phase 3 moved the message log to Postgres, but not every consumer reads it
 * through `ReactorConversationService.getChatSession`. In particular the AI
 * provider base (`AIProviderBase.loadChatState`) loads the Mongo conversation
 * document directly and hands its `history` array to the model — so before this
 * helper existed, removing the embedded array would have left every provider
 * with no conversation context, while also being silently re-created by
 * `persistChatState`.
 *
 * Returns the active transcript from the message store, or **null** when the
 * caller should fall back to the Mongo array. Falling back is deliberate and
 * mirrors `ReactorConversationService.loadActiveHistory`:
 *
 *  - source is `mongo` — the embedded array is authoritative;
 *  - the store is unavailable — never fail a chat turn on the message store;
 *  - Postgres holds no rows for a conversation Mongo does — a *mirror gap* must
 *    not hand the model an empty context, which would be far worse than using a
 *    slightly stale array;
 *  - the read throws — log and fall back rather than break the turn.
 */
export const loadHistoryForContext = async (
  conversationId: string | undefined,
  mongoHistory: any[] | undefined,
  context?: { warn?: (message: string, data?: any) => void }
): Promise<any[] | null> => {
  if (!conversationId) return null;
  if (resolveMessagesSource() !== "postgres") return null;

  try {
    const store = new ReactorConversationMessageService();
    if (!store.isAvailable()) return null;

    const rows = await store.getActiveMessages(conversationId);

    // A conversation Mongo has messages for but Postgres does not is a mirror
    // gap, not an empty conversation. Keep using the array.
    if (rows.length === 0 && Array.isArray(mongoHistory) && mongoHistory.length > 0) {
      context?.warn?.(
        "Postgres holds no messages for a conversation Mongo does; using Mongo history",
        { conversationId, mongoItems: mongoHistory.length }
      );
      return null;
    }

    return store.toMessages(rows);
  } catch (error) {
    context?.warn?.(
      "History read from Postgres failed; falling back to Mongo history",
      {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
};
