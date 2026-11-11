/**
 * Path, validation and containment helpers for the three AI persona layers.
 *
 * Personas are resolved from up to three roots, lowest precedence first:
 *
 * 1. **module**   — `<module>/ai/persona/<agent>/` (registered at startup)
 * 2. **operator** — `~/.reactor/ai/persona/<agent>/` (trusted desktop operator)
 * 3. **user**     — `<REACTORY_DATA>/profiles/<USERID>/reactor/ai/persona/<agent>/`
 *
 * The first two layers are trusted input. The third is **untrusted**: it is written by
 * whichever user is calling the API. Everything in this module exists so that the user
 * layer can be resolved without ever reading (or writing) outside
 * `<dataRoot>/profiles/<userId>/reactor/ai/`.
 *
 * Security properties enforced here:
 *
 * - SEC-1  user ids are taken from the request context and validated against a strict
 *          pattern; `.`, `..`, `/`, `\` and null bytes are rejected before any read.
 * - SEC-2  containment is decided with `path.relative` (plus a `realpath` check when the
 *          target exists), never with a string `startsWith`.
 * - SEC-3  prompt file includes for a user layer may only name relative paths inside the
 *          user's `reactor/ai` tree; absolute paths and `..` traversal are rejected.
 * - SEC-6  avatars are resolved inside the user's own persona folder — nothing is copied
 *          into the shared `profiles/reactor/personas/**` namespace.
 *
 * @since 1.0.0
 */
import * as fs from 'fs';
import * as path from 'path';

/** Where a persona layer came from. `module` layers are registry-owned. */
export type PersonaSourceKind = 'module' | 'operator' | 'user';

/** A single applied persona layer, recorded on the resolved persona. */
export interface PersonaSourceRef {
  source: PersonaSourceKind;
  /** Absolute directory the layer was read from. */
  path: string;
}

/**
 * Allowed user id shape. Deliberately narrow: a user id must start alphanumerically and
 * may only contain alphanumerics, dot, underscore, at-sign and hyphen. That excludes path
 * separators, null bytes, leading dots and shell/glob metacharacters.
 */
export const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const containsNullByte = (value: string): boolean => value.includes('\0');

/**
 * Validate a user id before it is used as a path segment.
 *
 * @param raw - Candidate user id (usually `context.user._id`).
 * @returns The trimmed id when valid, otherwise `null`.
 */
export function sanitizeUserId(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (!value) return null;
  if (value === '.' || value === '..') return null;
  if (containsNullByte(value)) return null;
  if (value.includes('/') || value.includes('\\')) return null;
  if (!USER_ID_PATTERN.test(value)) return null;

  return value;
}

/**
 * Resolve the calling user id from the request context only.
 *
 * A user id is never accepted from request arguments for this feature — the context is the
 * only trusted source. Startup, workflow and system contexts have no `user`, which is what
 * keeps the third layer out of non-request execution.
 *
 * @param context - Reactory execution context (lean documents supported).
 * @returns A validated user id or `null`.
 */
export function resolveCallingUserId(context: any): string | null {
  const user = context?.user;
  if (!user) return null;

  // `_id` is an ObjectId on hydrated documents and a string on lean ones; `id` is the
  // string form used by the GraphQL/auth layers. A lean document may carry an `_id` that is
  // a plain object, whose `toString()` yields the truthy-but-useless "[object Object]" — so
  // every candidate is validated and the first acceptable one wins instead of relying on
  // nullish coalescing.
  const candidates: unknown[] = [];

  try {
    const fromObjectId = user._id?.toString?.();
    if (typeof fromObjectId === 'string') candidates.push(fromObjectId);
  } catch {
    // A hostile/broken `toString` must not fail persona resolution.
  }

  if (typeof user.id === 'string') candidates.push(user.id);
  if (typeof user._id === 'string') candidates.push(user._id);

  for (const candidate of candidates) {
    const sanitized = sanitizeUserId(candidate as string);
    if (sanitized) return sanitized;
  }

  return null;
}

/**
 * Resolve the Reactory data root using the same convention as `ReactorChatState.ts` and
 * the MCP macros: `REACTORY_DATA`, then `APP_DATA_ROOT`.
 *
 * @returns An absolute path, or `null` when neither variable is configured.
 */
export function resolveDataRoot(): string | null {
  const configured = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!configured || !String(configured).trim()) return null;

  return path.resolve(String(configured).trim());
}

/**
 * The operator layer root: `~/.reactor/ai/persona`.
 *
 * @returns An absolute path, or `null` when no home directory is configured.
 */
export function resolveLegacyPersonaRoot(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || !String(home).trim()) return null;

  return path.join(String(home).trim(), '.reactor', 'ai', 'persona');
}

/**
 * `path.relative`-based containment check. A candidate equal to the root is inside it.
 *
 * @param root      - Directory that must contain the candidate.
 * @param candidate - Path to test.
 */
export function isPathInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;

  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, candidateResolved);

  if (relative === '') return true;
  if (relative === '..') return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(relative)) return false;

  return true;
}

/**
 * Containment check that also resolves symlinks for paths that exist.
 *
 * Lexical containment alone would allow `<layer>/prompts -> /etc` to escape; resolving the
 * real path closes that. Non-existent candidates fall back to the lexical result (the
 * subsequent read fails anyway).
 *
 * @param root      - Directory that must contain the candidate.
 * @param candidate - Path to test.
 */
export function isPathInsideReal(root: string, candidate: string): boolean {
  if (!isPathInside(root, candidate)) return false;

  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return isPathInside(realRoot, realCandidate);
  } catch {
    return true;
  }
}

/**
 * `<dataRoot>/profiles`, the only root a user-scoped read may start from.
 */
export function resolveUserProfilesRoot(): string | null {
  const dataRoot = resolveDataRoot();
  if (!dataRoot) return null;

  return path.join(dataRoot, 'profiles');
}

/**
 * Canonical (realpath) form of `<dataRoot>/profiles/<userId>`.
 *
 * SEC-2: a lexically-built root is not trustworthy, because `profiles/<userId>` (or anything
 * below it) may be a symlink into another user's tree. The canonical directory must:
 *
 * - still resolve inside `realpath(<dataRoot>/profiles)`, and
 * - still be named exactly `<userId>`,
 *
 * which together reject a `profiles/userA -> profiles/userB` redirect as well as a redirect
 * out of the data root. Returns `null` when the directory does not exist.
 *
 * @param userId - Raw user id; validated before use.
 */
export function resolveUserProfileDir(userId: string): string | null {
  const sanitized = sanitizeUserId(userId);
  if (!sanitized) return null;

  const profilesRoot = resolveUserProfilesRoot();
  if (!profilesRoot) return null;

  const lexicalUserDir = path.join(profilesRoot, sanitized);
  if (!isPathInside(profilesRoot, lexicalUserDir)) return null;

  try {
    const realProfilesRoot = fs.realpathSync(profilesRoot);
    const realUserDir = fs.realpathSync(lexicalUserDir);

    if (path.basename(realUserDir) !== sanitized) return null;
    if (!isPathInside(realProfilesRoot, realUserDir)) return null;

    return realUserDir;
  } catch {
    // Not created yet — there is no profile layer for this user.
    return null;
  }
}

/**
 * `<dataRoot>/profiles/<userId>/reactor/ai` — the containment root for every path read on
 * behalf of a user layer (YAML, markdown, prompt includes, avatar).
 *
 * The returned path is the **canonical** directory (realpath), verified to resolve inside
 * `realpath(<dataRoot>/profiles/<userId>)`, so it is safe to use as `restrictTo` and as the
 * root for every later containment check. Returns `null` when the tree does not exist or is
 * redirected outside the user's own directory.
 *
 * @param userId - Raw user id; validated before use.
 */
export function resolveUserAiRoot(userId: string): string | null {
  const userDir = resolveUserProfileDir(userId);
  if (!userDir) return null;

  const lexicalAiRoot = path.join(userDir, 'reactor', 'ai');
  if (!isPathInside(userDir, lexicalAiRoot)) return null;

  try {
    const realAiRoot = fs.realpathSync(lexicalAiRoot);
    if (!isPathInside(userDir, realAiRoot)) return null;

    return realAiRoot;
  } catch {
    return null;
  }
}

/**
 * `<dataRoot>/profiles/<userId>/reactor/ai/persona` — the user persona layer root.
 *
 * Canonicalised like {@link resolveUserAiRoot} so a symlinked `persona` folder cannot point
 * at another user's personas. Returns `null` when the folder does not exist.
 *
 * @param userId - Raw user id; validated before use.
 */
export function resolveUserPersonaRoot(userId: string): string | null {
  const aiRoot = resolveUserAiRoot(userId);
  if (!aiRoot) return null;

  const lexicalPersonaRoot = path.join(aiRoot, 'persona');
  if (!isPathInside(aiRoot, lexicalPersonaRoot)) return null;

  try {
    const realPersonaRoot = fs.realpathSync(lexicalPersonaRoot);
    if (!isPathInside(aiRoot, realPersonaRoot)) return null;

    return realPersonaRoot;
  } catch {
    return null;
  }
}

/**
 * Candidate folder names for a persona id.
 *
 * Mirrors the historical `~/.reactor` behaviour exactly (exact id, lower-case id, id with
 * `aipersona` stripped) so the operator and user layers cannot drift. Both layers call
 * this one helper.
 *
 * @param personaId - Persona id, e.g. `ReactorAIPersona`.
 */
export function personaCandidateNames(personaId?: string | null): string[] {
  if (typeof personaId !== 'string' || !personaId.trim()) return [];

  const names = new Set<string>();
  const add = (candidate?: string) => {
    if (typeof candidate !== 'string') return;

    const value = candidate.trim();
    if (!value || value === '.' || value === '..') return;
    if (containsNullByte(value)) return;
    if (value.includes('/') || value.includes('\\')) return;

    names.add(value);
  };

  add(personaId);
  add(personaId.toLowerCase());
  add(personaId.replace(/aipersona/i, '').toLowerCase());

  return Array.from(names);
}

/**
 * Resolve the layer directory for a persona id inside a root.
 *
 * @param root      - Layer root (`~/.reactor/ai/persona` or the user persona root).
 * @param personaId - Persona id to resolve.
 * @returns The first existing candidate directory, or `null`.
 */
export function resolveLayerDir(root: string | null | undefined, personaId?: string | null): string | null {
  if (!root || !personaId) return null;

  for (const candidate of personaCandidateNames(personaId)) {
    const dir = path.join(root, candidate);
    if (!isPathInside(root, dir) || path.resolve(dir) === path.resolve(root)) continue;

    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && isPathInsideReal(root, dir)) {
        return dir;
      }
    } catch {
      // Unreadable candidate — try the next one.
    }
  }

  return null;
}

/**
 * List the persona directories declared by a user profile (one level, directories only).
 *
 * @param userId - Raw user id; validated before use.
 * @returns Absolute directory paths inside the user's persona root, sorted for determinism.
 */
export function listProfilePersonaDirs(userId: string): string[] {
  const personaRoot = resolveUserPersonaRoot(userId);
  if (!personaRoot) return [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(personaRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(personaRoot, entry.name);
    if (!isPathInside(personaRoot, dir)) continue;
    if (!isPathInsideReal(personaRoot, dir)) continue;

    dirs.push(dir);
  }

  return dirs.sort();
}

/** Result of filtering a user layer's `prompts.<key>.files` declarations. */
export interface PromptFileSelection {
  /** Declarations that are safe to read, in their original order. */
  allowed: string[];
  /** Declarations rejected by the restriction (absolute paths, traversal, escapes). */
  rejected: string[];
}

/**
 * Decide whether a `prompts.<key>.files` entry may be read for a user layer (SEC-3).
 *
 * @param restrictRoot - Root the resolved file must stay inside (the user's `reactor/ai`).
 * @param declared     - The raw entry from YAML.
 * @param baseDir      - Directory relative entries resolve against (the persona folder).
 */
export function isPromptIncludeAllowed(
  restrictRoot: string,
  declared: string,
  baseDir?: string,
): boolean {
  if (!restrictRoot || typeof declared !== 'string') return false;

  const value = declared.trim();
  if (!value || containsNullByte(value)) return false;

  // Absolute paths are never acceptable from an untrusted layer, on any platform.
  if (path.isAbsolute(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;

  // `..` anywhere in the declared path is traversal, even if it happens to resolve inside.
  if (value.split(/[\\/]+/).some((segment) => segment === '..')) return false;

  const resolvedPath = path.resolve(baseDir || restrictRoot, value);
  return isPathInside(restrictRoot, resolvedPath) && isPathInsideReal(restrictRoot, resolvedPath);
}

/**
 * Filter a user layer's prompt file declarations down to the safe ones (SEC-3).
 *
 * A rejected entry is skipped by the caller with a warning; its contents must never reach
 * the prompt.
 *
 * @param restrictRoot - Root every include must resolve inside.
 * @param files        - Raw `prompts.<key>.files` value.
 * @param baseDir      - Directory relative entries resolve against.
 */
export function resolveUserPromptFiles(
  restrictRoot: string,
  files: unknown,
  baseDir?: string,
): PromptFileSelection {
  const allowed: string[] = [];
  const rejected: string[] = [];

  if (!Array.isArray(files)) return { allowed, rejected };

  for (const file of files) {
    if (typeof file !== 'string' || file.trim().length === 0) continue;

    const declared = file.trim();
    if (isPromptIncludeAllowed(restrictRoot, declared, baseDir)) {
      allowed.push(declared);
    } else {
      rejected.push(declared);
    }
  }

  return { allowed, rejected };
}

/**
 * Resolve a per-user avatar for a persona (SEC-6).
 *
 * Looks in the user's own persona folder — `<dataRoot>/profiles/<userId>/reactor/ai/persona/<agent>/avatar.png`
 * — and never in the shared `profiles/reactor/personas/**` namespace, so two users that
 * define the same persona id cannot collide or shadow a built-in avatar.
 *
 * @param userId    - Raw user id; validated before use.
 * @param personaId - Persona id.
 * @param fileName  - Optional avatar file name; treated as untrusted, so separators are ignored.
 * @returns Absolute path when the file exists inside the layer, otherwise `null`.
 */
export function resolveUserAvatarPath(
  userId: string,
  personaId: string,
  fileName?: string,
  preferredDir?: string,
): string | null {
  const personaRoot = resolveUserPersonaRoot(userId);
  const aiRoot = resolveUserAiRoot(userId);
  if (!personaRoot || !aiRoot) return null;

  // A profile-only persona's folder name need not match its id, so the caller may pass the
  // layer directory it resolved from `personaSources`; it must still sit inside this user's
  // `reactor/ai` tree.
  let layerDir: string | null = null;
  if (preferredDir && isPathInside(aiRoot, preferredDir) && isPathInsideReal(aiRoot, preferredDir)) {
    try {
      if (fs.statSync(preferredDir).isDirectory()) layerDir = path.resolve(preferredDir);
    } catch {
      layerDir = null;
    }
  }

  if (!layerDir) layerDir = resolveLayerDir(personaRoot, personaId);
  if (!layerDir || !isPathInside(aiRoot, layerDir)) return null;

  const avatarName = typeof fileName === 'string'
    && fileName.trim().length > 0
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && !containsNullByte(fileName)
    && fileName !== '.'
    && fileName !== '..'
    ? fileName.trim()
    : 'avatar.png';

  const candidate = path.join(layerDir, avatarName);
  if (!isPathInside(layerDir, candidate)) return null;
  if (!isPathInsideReal(layerDir, candidate)) return null;

  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Express an absolute path relative to the data root so it can be handed to `safeCDNUrl`.
 *
 * @param absolutePath - Path inside the data root.
 * @returns A forward-slash relative path, or `null` when it is outside the data root.
 */
export function toDataRootRelativePath(absolutePath: string): string | null {
  const dataRoot = resolveDataRoot();
  if (!dataRoot || !absolutePath) return null;

  // Paths handed in here are canonical (they went through realpath containment), while
  // REACTORY_DATA may be a symlinked path itself (macOS `/var` -> `/private/var`). Accept both
  // forms or a per-user avatar would silently lose its CDN URL on such a data root.
  const candidates: string[] = [dataRoot];
  try {
    const realDataRoot = fs.realpathSync(dataRoot);
    if (realDataRoot !== dataRoot) candidates.push(realDataRoot);
  } catch {
    // Data root not created yet — the lexical form is all we have.
  }

  for (const root of candidates) {
    if (!isPathInside(root, absolutePath)) continue;
    return path.relative(root, absolutePath).split(path.sep).join('/');
  }

  return null;
}

export default {
  USER_ID_PATTERN,
  sanitizeUserId,
  resolveCallingUserId,
  resolveDataRoot,
  resolveLegacyPersonaRoot,
  isPathInside,
  isPathInsideReal,
  resolveUserProfilesRoot,
  resolveUserProfileDir,
  resolveUserAiRoot,
  resolveUserPersonaRoot,
  personaCandidateNames,
  resolveLayerDir,
  listProfilePersonaDirs,
  isPromptIncludeAllowed,
  resolveUserPromptFiles,
  resolveUserAvatarPath,
  toDataRootRelativePath,
};
