import Hash from "@reactory/server-core/utils/hash";
import { IReactorProject } from "../../types/service.types";

/**
 * GraphIdentity centralises how nodes and edges are identified in the
 * Reactor system graph.
 *
 * Node identity is **deterministic**: a node's numeric id is derived from a
 * stable "logical key" that encodes its position in the graph (project +
 * relative path + optional symbol). This gives us three important properties:
 *
 *  1. Re-processing a project produces the same ids, so cached/persisted nodes
 *     and edges never dangle across rebuilds.
 *  2. An edge can reference a target node (e.g. an imported file or symbol) by
 *     computing its id from the logical key alone - without having built that
 *     part of the tree first.
 *  3. There is a single id space (numeric hash) regardless of whether a project
 *     originated from Mongo or the static catalog.
 *
 * There are two distinct "keys" in the model - do not confuse them:
 *
 *  - **logicalKey**  a human-meaningful, stable path used to derive the id.
 *                    e.g. "reactor.my-service@1.0.0::src/index.ts#MyClass"
 *  - **ancestryKey** the pipe-delimited path of *ids* stored on `node.key`,
 *                    used by SystemGraphManager.getNode to walk the tree.
 *                    e.g. "12345|67890|-4242"
 */

const LOGICAL_SEP = "::";
const SYMBOL_SEP = "#";
const ANCESTRY_SEP = "|";

/** Returns the fully-qualified name for a project, used as the graph root key. */
export const projectFqn = (project: Partial<IReactorProject>): string => {
  if (project.fqn) return project.fqn;
  const version = project.version || "1.0.0";
  return `${project.nameSpace}.${project.name}@${version}`;
};

/** Derives a deterministic numeric node id from a logical key. */
export const nodeId = (logicalKey: string): number => Hash(logicalKey);

/** Logical key for the project root node. */
export const projectLogicalKey = (project: Partial<IReactorProject>): string =>
  projectFqn(project);

/**
 * Logical key for a file or folder node.
 * @param fqn the owning project fqn
 * @param relativePath path relative to the project repoPath (posix-normalised)
 */
export const pathLogicalKey = (fqn: string, relativePath: string): string =>
  `${fqn}${LOGICAL_SEP}${normalizeRelative(relativePath)}`;

/**
 * Logical key for a symbol node (class, function, interface, etc.) living
 * inside a file.
 */
export const symbolLogicalKey = (
  fqn: string,
  relativePath: string,
  symbol: string
): string =>
  `${pathLogicalKey(fqn, relativePath)}${SYMBOL_SEP}${symbol}`;

/** Normalise a relative path to forward slashes and strip leading "./". */
export const normalizeRelative = (relativePath: string): string => {
  const p = (relativePath || "").split("\\").join("/");
  return p.startsWith("./") ? p.slice(2) : p;
};

/** Appends a child id to a parent ancestry key. */
export const appendAncestry = (
  parentKey: string | undefined,
  id: number
): string => (parentKey ? `${parentKey}${ANCESTRY_SEP}${id}` : `${id}`);

/** Splits an ancestry key into its component ids (numbers). */
export const parseAncestry = (key: string): number[] => {
  if (!key) return [];
  return key
    .split(ANCESTRY_SEP)
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
};

/** The root (first) id in an ancestry key. */
export const rootAncestry = (key: string): number | undefined =>
  parseAncestry(key).shift();

/**
 * Canonical string representation of a project id, or undefined if absent.
 */
export const canonicalProjectId = (
  project: Partial<IReactorProject>
): string | undefined => {
  const raw =
    (project as any)?.id ??
    (project as any)?._id ??
    null;
  if (raw == null || raw === "") return undefined;
  return String(raw);
};

/**
 * Logical key for an entity in an **external source** (a source that is not a
 * folder on disk): a Jira site, a database connection, etc.
 *
 * Shape: `scheme:<sourceKey>[/<entityPath>][#<fragment>]`
 *
 *  - `scheme`      short registry name of the source kind ('jira', 'db', ...)
 *  - `sourceKey`   stable identifier of the source instance
 *                  (site host, connectionId) - never a URL with credentials
 *  - `entityPath`  slash path locating the entity inside the source
 *                  ('WR', 'sales/dbo/orders')
 *  - `fragment`    leaf entity inside the path ('WR-123', a column name)
 *
 * Examples:
 *  - `jira:worldremit.atlassian.net/WR#WR-123`
 *  - `db:sales-dwh/dbo/orders#customer_id`
 *
 * The id of an external entity is `nodeId(sourceLogicalKey(...))` - a pure
 * function of the *reference*, so cross-domain linkers (a doc mentioning
 * `WR-123`) can compute the target node id without fetching anything. This is
 * the same property that makes document anchors resolvable without parsing the
 * target document (invariant P1).
 */
export const sourceLogicalKey = (
  scheme: string,
  sourceKey: string,
  entityPath?: string,
  fragment?: string
): string => {
  let key = `${scheme}:${sourceKey}`;
  if (entityPath) key += `/${normalizeRelative(entityPath)}`;
  if (fragment) key += `${SYMBOL_SEP}${fragment}`;
  return key;
};

/**
 * Deterministic edge id from its endpoints and primary type. Making the id a
 * function of (source, target, type) means the same relationship discovered on
 * two runs collapses to one edge rather than duplicating.
 */
export const linkId = (
  source: number,
  target: number,
  type: string
): number => Hash(`${source}->${target}:${type}`);
