/**
 * Curated search-index catalog (Providers Session 08).
 *
 * Agents can only search what they can name — this module is the tenant-safe
 * answer to "which indexes exist?". The catalog is built from what the CALLER
 * may see (their projects + module-registered well-known indexes); the raw
 * backend listing (`ISearchProvider.listIndexes`) only ANNOTATES entries with
 * existence/document counts and never contributes entries of its own, so other
 * tenants' or applications' indexes cannot leak through discovery.
 */

export interface SearchIndexCatalogEntry {
  /** The index name to pass to search tools (e.g. reactor_graph_<ns>_<name>). */
  index: string;
  kind: "project" | "module";
  /** Human/agent-readable identity (project fqn or module feature name). */
  title: string;
  /** What the index contains — this is what an LLM reads to pick an index. */
  description?: string;
  lastSync?: Date;
  /** Annotated from the backend listing when available. */
  documentCount?: number;
  /** Annotated from the backend listing when available; undefined = unknown. */
  exists?: boolean;
}

const moduleIndexes = new Map<string, SearchIndexCatalogEntry>();

/**
 * Registers module-owned, well-known indexes (kb articles, book content, ...)
 * so they appear in the catalog for every caller. Idempotent by index name.
 */
export const registerModuleSearchIndexes = (
  entries: Array<Omit<SearchIndexCatalogEntry, "kind">>
): void => {
  for (const entry of entries || []) {
    if (!entry?.index) continue;
    moduleIndexes.set(entry.index, { ...entry, kind: "module" });
  }
};

export const getModuleSearchIndexes = (): SearchIndexCatalogEntry[] =>
  Array.from(moduleIndexes.values());

/** Test hook. */
export const clearModuleSearchIndexes = (): void => {
  moduleIndexes.clear();
};
