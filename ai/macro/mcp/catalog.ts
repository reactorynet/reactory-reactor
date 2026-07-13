/**
 * MCP service catalog — the registry the agent connects against.
 *
 * Merges the curated operator catalog (`$REACTORY_DATA/profiles/reactor/mcp/
 * available.yaml`) with the user's standard config (`~/.reactor/mcp.{json,yaml}`,
 * via ./standard-config). Shared by the macro and the OAuth callback route (which
 * resolves a server's URL/auth by id, out of band from any chat session).
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  AvailableServiceEntry,
  loadStandardMcpServers,
  resolveEnvTemplate,
} from "./standard-config";

export const availableCatalogPath = (): string | null => {
  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!dataRoot) return null;
  return path.join(dataRoot, "profiles", "reactor", "mcp", "available.yaml");
};

/** Reads the curated operator catalog (`available.yaml`) only. */
const loadCuratedCatalog = (): AvailableServiceEntry[] => {
  const p = availableCatalogPath();
  if (!p || !fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = yaml.load(raw) as { services?: AvailableServiceEntry[] } | undefined;
    return (parsed?.services ?? []).map((svc) => ({
      ...svc,
      // Accept legacy 'sse' catalog entries but normalise to 'http'.
      transport: (svc.transport as string) === "sse" ? "http" : svc.transport,
      url: svc.url ? resolveEnvTemplate(svc.url) : undefined,
      source: "available.yaml" as const,
    }));
  } catch {
    return [];
  }
};

/**
 * The full registry: curated catalog merged with the user's standard config,
 * keyed by id. The curated catalog wins on collision because it is
 * operator-controlled and drives credential forwarding.
 */
export const loadAvailableCatalog = (): AvailableServiceEntry[] => {
  const byId = new Map<string, AvailableServiceEntry>();
  for (const svc of loadStandardMcpServers()) byId.set(svc.id, svc);
  for (const svc of loadCuratedCatalog()) byId.set(svc.id, svc);
  return Array.from(byId.values());
};

/** Resolve a single catalog entry by service id. */
export const findCatalogEntry = (id: string): AvailableServiceEntry | undefined =>
  loadAvailableCatalog().find((svc) => svc.id === id);
