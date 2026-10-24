import Reactory from '@reactorynet/reactory-core';
import { query, resolver } from '@reactory/server-core/models/graphql/decorators/resolver';
import AgentContinuationService, {
  IContinuationPublicView,
} from '../../services/reactor/AgentContinuationService';

/**
 * `ReactorPendingContinuations` — the observability half of durable agent
 * continuations (REACTORY-302016408).
 *
 * An agent that says "I am waiting on PR 482 until 14:00" must be checkable. This
 * query is the read surface behind that sentence: it returns the caller's records,
 * their deadlines and their states, so a support engineer (or the user) can see the
 * wait exists instead of taking the transcript's word for it.
 *
 * ── Two boundaries this file enforces ─────────────────────────────────────────
 *
 * 1. **No credential.** `correlationKey` is the wake credential. The service's
 *    `listForViewer()` already projects through `toPublicView()` (which drops it),
 *    and this resolver re-projects into exactly the nine fields the schema
 *    declares. Two independent reductions, because a future edit to one of them
 *    must not be enough to expose the key.
 *
 * 2. **No cross-tenant reads.** Ownership is decided in the service
 *    (`listForViewer`), not here: the resolver passes the argument through and the
 *    service either scopes to `context.user._id` or refuses an admin-only `userId`.
 *    Doing it in one place means the todo projection and this query can never
 *    disagree about who may see what.
 *
 * ── `this` is not available ───────────────────────────────────────────────────
 *
 * The graph registry harvests resolver classes without running the constructor and
 * merges the decorator map into a shared root object, so at execution time `this`
 * is the merged map. Everything here is a module-level function or a plain method
 * that touches no instance state. (This has bitten the repo before: see
 * `graphql/resolvers/ReactorAIUsage.ts`.)
 */

const CONTINUATION_SERVICE_ID = 'reactor.AgentContinuationService@1.0.0';

export interface IReactorPendingContinuationsArgs {
  chatSessionId?: string;
  includeTerminal?: boolean;
  /** Administrators only — a non-admin caller is refused by the service. */
  userId?: string;
  limit?: number;
}

/**
 * The wire shape. Exactly the fields the schema declares and nothing else.
 *
 * Written as an explicit pick rather than returning the service view directly so
 * that a field added to `IContinuationPublicView` later (a prompt, an owner email,
 * anything) cannot appear on this surface by accident. GraphQL would drop unknown
 * fields anyway; this is the belt to that braces, and it is what the "serialised
 * result has no correlationKey" test asserts against.
 */
export function toPendingContinuationShape(view: IContinuationPublicView & Record<string, any>) {
  return {
    continuationId: String(view?.continuationId ?? ''),
    reason: String(view?.reason ?? ''),
    state: String(view?.state ?? ''),
    fireAt: view?.fireAt ?? null,
    firedAt: view?.firedAt ?? null,
    outcome: view?.outcome ?? null,
    chatSessionId: String(view?.chatSessionId ?? ''),
    personaId: String(view?.personaId ?? ''),
    createdAt: view?.createdAt ?? null,
  };
}

@resolver
class ReactorContinuationResolver {
  resolver: any;

  @query('ReactorPendingContinuations')
  async ReactorPendingContinuations(
    _: any,
    args: IReactorPendingContinuationsArgs,
    context: Reactory.Server.IReactoryContext,
  ) {
    const service = context.getService<AgentContinuationService>(CONTINUATION_SERVICE_ID);
    if (!service || typeof (service as any).listForViewer !== 'function') {
      // Fail loudly rather than returning []: "no pending continuations" and "the
      // service that knows about them is missing" must not look the same.
      throw new Error(
        `${CONTINUATION_SERVICE_ID} is not available, so pending continuations cannot be listed.`,
      );
    }

    const views = await (service as any).listForViewer({
      chatSessionId: args?.chatSessionId || undefined,
      includeTerminal: args?.includeTerminal === true,
      userId: args?.userId || undefined,
      limit: args?.limit ?? undefined,
    });

    return (Array.isArray(views) ? views : []).map(toPendingContinuationShape);
  }
}

export default ReactorContinuationResolver;
