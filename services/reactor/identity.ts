/**
 * Shared identity predicates for reactor's background/agent services.
 *
 * These live in one file because two features now need the SAME definition of
 * "administrative" and "the platform's system account", and a second spelling of
 * either would drift:
 *
 *  - `AgentContinuationService` uses them to authorise reading another user's
 *    continuations and to refuse a wait registered by the system account;
 *  - `WorkflowProgrammeService` uses them to authorise pause/resume/abort, which
 *    the design requires to name a PERSON in the audit trail.
 *
 * `AgentContinuationService` re-exports these names, so its public surface (and
 * every existing import of them) is unchanged.
 */

/**
 * Roles allowed to read another user's continuations / control a programme.
 *
 * Mirrors `graphql/resolvers/ReactorAIUsage.ts` deliberately: the platform has one
 * spelling of "administrative" and a second one here would drift.
 */
export const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN', 'DEVELOPER'];

/** Whether the given Reactory context carries an administrative role. */
export function hasAdministrativeRole(context: any): boolean {
  if (!context) return false;
  if (typeof context.hasRole === 'function') {
    try {
      if (ADMIN_ROLES.some((role) => context.hasRole(role) === true)) return true;
    } catch {
      /* fall through to the role list */
    }
  }
  const roles: string[] = (((context.user as any)?.roles ?? []) as string[]) || [];
  return (
    Array.isArray(roles) &&
    roles.some((role) => ADMIN_ROLES.includes(String(role).toUpperCase()))
  );
}

/** True when the given user document is the platform's system account. */
export function isSystemIdentity(user: any): boolean {
  if (!user) return false;
  const systemEmail = String(process.env.SYSTEM_USER_EMAIL || '').trim().toLowerCase();
  const systemId = String(process.env.SYSTEM_USER_ID || '').trim();
  const email = String(user.email || '').trim().toLowerCase();
  const id = String(user._id || user.id || '').trim();
  if (systemEmail && email && email === systemEmail) return true;
  if (systemId && id && id === systemId) return true;
  return false;
}
