/**
 * Cross-domain ticket linking (Providers Session 04).
 *
 * Shared helpers connecting the code/documentation graph to catalogued Jira
 * ticket nodes. Everything here is computable from a *reference* alone: a
 * ticket key + its registered site yields the ticket's node id via
 * `sourceLogicalKey` (invariant P1), so linkers never fetch from Jira.
 *
 * Gate (I4/P3): an edge is only emitted when the ticket key's project prefix
 * belongs to a **registered** Jira source. Mentions never create ticket nodes.
 */
import { ReactorProjectModel } from "../../models/ReactorProject";
import { DocumentOutline } from "./documents";
import { nodeId, sourceLogicalKey } from "./GraphIdentity";

/** A candidate ticket key: PREFIX-123 (prefix 2-10 chars, starts alpha). */
export const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/**
 * Prefixes that pattern-match ticket keys but are almost always standards or
 * technology names (`UTF-8`, `SHA-256`, `RFC-2119`, `TLS-1`). Defense in depth
 * — the registered-source gate already excludes them unless someone registers
 * a Jira project with one of these keys, in which case the denylist wins.
 */
export const TICKET_PREFIX_DENYLIST = new Set([
  "UTF", "ISO", "SHA", "RFC", "TLS", "SSL", "MD", "AES", "RSA", "GPT", "EC",
  "HTTP", "HTTPS", "API", "ID", "UUID", "CSS", "HTML", "JSON", "YAML", "SQL",
  "JWT", "OAUTH", "X", "V", "IPV", "IP", "TCP", "UDP", "DNS", "CVE", "PCI",
  "GDPR", "IEEE", "ECMA", "ES", "UTF8", "BASE", "CRC", "HMAC", "PBKDF",
]);

export interface TicketSource {
  /** Jira site host (the source's sourceKey). */
  site: string;
  /** ReactorProject id of the registered Jira source. */
  sourceProjectId: string;
}

/** Upper-cased Jira project key → its registered source. */
export type TicketSourceIndex = Map<string, TicketSource>;

/**
 * Builds the registered-ticket-source index from `reactor_projects` records
 * with `source.scheme: 'jira'` (the "publisher index" analogue of session 12).
 */
export const buildTicketSourceIndex = async (): Promise<TicketSourceIndex> => {
  const index: TicketSourceIndex = new Map();
  let sources: any[] = [];
  try {
    sources = (await ReactorProjectModel.find({ "source.scheme": "jira" })
      .select({ _id: 1, source: 1 })
      .lean()) as any[];
  } catch {
    return index;
  }
  for (const p of sources || []) {
    const site = p?.source?.sourceKey;
    const keys: string[] = p?.source?.options?.projectKeys || [];
    if (!site || !Array.isArray(keys)) continue;
    for (const key of keys) {
      if (!key) continue;
      index.set(String(key).toUpperCase(), {
        site,
        sourceProjectId: String(p._id || p.id),
      });
    }
  }
  return index;
};

/** Deterministic node id of a ticket, from its key + registered site (P1). */
export const ticketNodeIdFor = (site: string, ticketKey: string): number =>
  nodeId(sourceLogicalKey("jira", site, ticketKey.split("-")[0], ticketKey));

/** Deterministic node id of a Jira project container node. */
export const jiraProjectNodeIdFor = (site: string, projectKey: string): number =>
  nodeId(sourceLogicalKey("jira", site, projectKey.toUpperCase()));

/**
 * Parses a Jira URL into { host, ticketKey?, projectKey? }. Recognised forms:
 *   https://<site>/browse/KEY-123
 *   https://<site>/browse/KEY
 *   https://<site>/jira/software/(c/)projects/KEY/... (optionally .../issues/KEY-123)
 * Returns null for anything else.
 */
export const parseJiraUrl = (
  url: string
): { host: string; ticketKey?: string; projectKey?: string } | null => {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const path = parsed.pathname;

  const browse = /^\/browse\/([A-Z][A-Z0-9]{1,9})(?:-(\d{1,6}))?$/i.exec(path);
  if (browse) {
    const projectKey = browse[1].toUpperCase();
    return browse[2]
      ? { host, projectKey, ticketKey: `${projectKey}-${browse[2]}` }
      : { host, projectKey };
  }

  const software = /^\/jira\/[^/]+\/(?:c\/)?projects\/([A-Z][A-Z0-9]{1,9})(?:\/.*)?$/i.exec(path);
  if (software) {
    const projectKey = software[1].toUpperCase();
    const issue = /\/issues\/([A-Z][A-Z0-9]{1,9}-\d{1,6})/i.exec(path);
    return issue
      ? { host, projectKey, ticketKey: issue[1].toUpperCase() }
      : { host, projectKey };
  }

  return null;
};

export interface TicketMention {
  ticketKey: string;
  projectKey: string;
  /** 1-based line of the mention. */
  line: number;
  match: "inline-code" | "prose";
  confidence: number;
  /** Anchor slug of the innermost containing section, when there is one. */
  sectionSlug?: string;
}

/**
 * Scans document content for ticket-key mentions, classifying each by context:
 * inside an inline code span or a fenced code block → 'inline-code' (0.95),
 * plain prose → 'prose' (0.85). Denylisted prefixes and prefixes not present
 * in `index` produce nothing. Mentions are de-duplicated per (section, key).
 */
export const scanTicketMentions = (
  content: string,
  outline: DocumentOutline | null,
  index: TicketSourceIndex
): TicketMention[] => {
  if (!content || index.size === 0) return [];
  const mentions: TicketMention[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  const fenceRanges = (outline?.codeBlocks || []).map((b: any) => [b.line, b.endLine]);
  const inFence = (line: number) => fenceRanges.some(([s, e]) => line >= s && line <= e);

  const sectionFor = (line: number): string | undefined => {
    let best: { slug: string; start: number } | undefined;
    for (const s of outline?.sections || []) {
      if (line >= s.line && line <= s.endLine) {
        if (!best || s.line >= best.start) best = { slug: s.slug, start: s.line };
      }
    }
    return best?.slug;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = lines[i];
    TICKET_KEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TICKET_KEY_RE.exec(text)) !== null) {
      const projectKey = m[1].toUpperCase();
      if (TICKET_PREFIX_DENYLIST.has(projectKey)) continue;
      if (!index.has(projectKey)) continue;
      const ticketKey = `${projectKey}-${m[2]}`;
      const sectionSlug = sectionFor(lineNo);
      const dedupeKey = `${sectionSlug || ""}::${ticketKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // inline code: odd number of backticks before the match on this line
      const backticksBefore = (text.slice(0, m.index).match(/`/g) || []).length;
      const inline = backticksBefore % 2 === 1 || inFence(lineNo);
      mentions.push({
        ticketKey,
        projectKey,
        line: lineNo,
        match: inline ? "inline-code" : "prose",
        confidence: inline ? 0.95 : 0.85,
        sectionSlug,
      });
    }
  }
  return mentions;
};
