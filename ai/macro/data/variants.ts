/**
 * Canonical database variants, and the spellings that mean the same thing.
 *
 * Why this file exists
 * --------------------
 * Each data macro guards itself with `connection.variant === '<canonical>'`, but
 * the variant string does not originate in the macro layer: it is authored in
 * partner settings (`src/data/clientConfigs/<client>/settings`) and in operator
 * configuration. The `reactory` app declares its MongoDB connection with
 * `variant: "mongodb"` while `DatabaseVariant` — and therefore every macro guard
 * — says `'mongo'`. The strict comparison rejected a correctly-declared
 * connection 100% of the time, and the error echoed "mongodb" back as the reason
 * it was "not a MongoDB connection".
 *
 * The fix is deliberately NOT to flip the literal to `'mongodb'`: `'mongo'` is
 * the documented canonical value, it appears in existing settings and tests, and
 * an operator may legitimately write either. Normalising means both spellings
 * resolve, and adding a third alias later is a one-line change in one place
 * rather than a hunt through every macro.
 *
 * Keep `DATABASE_VARIANTS` aligned with the `DatabaseVariant` union in
 * `./types.ts` — the compile-time check on `DATABASE_VARIANTS` enforces half of
 * it, and `__tests__/variantResolution.test.ts` enforces the rest.
 */
import { DatabaseVariant } from './types';

/** The canonical spelling of every variant a data macro can talk to. */
export const DATABASE_VARIANTS: readonly DatabaseVariant[] = [
  'postgres',
  'mysql',
  'mongo',
  'mssql',
  'databricks',
  'redis',
];

/**
 * Alternative spellings, mapped onto their canonical variant.
 *
 * Only genuine synonyms for the same wire protocol belong here. A different
 * product (e.g. `mariadb`, which is wire-compatible but not the same thing)
 * should be added deliberately, with a test, rather than guessed at.
 */
export const DATABASE_VARIANT_ALIASES: Readonly<Record<string, DatabaseVariant>> = Object.freeze({
  mongodb: 'mongo',
  postgresql: 'postgres',
  sqlserver: 'mssql',
});

/**
 * Resolve a declared variant to its canonical spelling.
 *
 * Case and surrounding whitespace are ignored, because they come from hand- and
 * LLM-authored configuration. Returns `undefined` for anything that is not a
 * known database variant — callers decide whether that is an error (a macro
 * guard) or something to pass through (the connection listing, which also
 * reports non-database connections such as prometheus or redis).
 */
export const normaliseDatabaseVariant = (variant: unknown): DatabaseVariant | undefined => {
  if (typeof variant !== 'string') return undefined;

  const key = variant.trim().toLowerCase();
  if (key.length === 0) return undefined;

  if ((DATABASE_VARIANTS as readonly string[]).includes(key)) {
    return key as DatabaseVariant;
  }

  return DATABASE_VARIANT_ALIASES[key];
};

/**
 * True when a declared variant (canonical or alias) resolves to `expected`.
 * This is the comparison every data macro guard should use.
 */
export const isDatabaseVariant = (variant: unknown, expected: DatabaseVariant): boolean =>
  normaliseDatabaseVariant(variant) === expected;
