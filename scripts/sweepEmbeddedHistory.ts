#!/usr/bin/env node
/**
 * Sweep for consumers of the embedded conversation `history` / `truncatedHistory` arrays.
 *
 * Retiring a field is not one change, because the array is consumed five different ways and only the
 * first is visible to a search for property reads:
 *
 *   1. READ       `conversation.history.filter(...)`, `.length`, `[i]`, `splice`
 *   2. QUERY      `{ "history.tool_calls.id": id }`, `{ history: { $size: 0 } }` used as a FILTER
 *   3. WRITE      `$push: { history: … }`, `$set: { "history.$.x": … }`
 *   4. PROJECTION a find/projection that includes the array
 *   5. ASSIGN     `session.history[i].rating = x` (read-modify-write)
 *
 * Once the array stops being written, (2) and (3) fail **silently**: a filter matches nothing, a
 * guarded loop is skipped. That is how the `new chat` defect (which filtered on `history: { $size: 0 }`)
 * and five array-operating mutations survived an audit that only looked for reads.
 *
 * Repeatable by design — re-run after each branching fix and the remaining count should fall. It is a
 * static scan: it finds *candidates*, and each one still needs the judgement of whether it is the
 * conversation array or an unrelated `history` (browser `window.history`, a Slack API path, a
 * playwright session's own history, the project-history form's field mapping).
 *
 * Usage:
 *   ... sweepEmbeddedHistory.ts [--all] [--json <path>] [--root <dir>]
 *
 * Default output is a bounded summary plus any hits OUTSIDE this module (possible cross-module
 * consumers). `--all` lists every production hit.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const ROOT = argValue("--root") || path.join(__dirname, "..");
const OUT = argValue("--json") || "/tmp/history-sweep.json";
const SHOW_ALL = args.includes("--all");

const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git", "coverage", "migrations"]);
const SKIP_FILE = /\.(graphql|json|md|snap|lock)$/;

interface Rule {
  id: string;
  kind: string;
  re: RegExp;
}

/** Ordered most-specific-first; the first rule that matches a line claims it. */
const RULES: Rule[] = [
  { id: "WRITE-push", kind: "WRITE", re: /\$push\s*:\s*\{[^}]*\bhistory\b/ },
  { id: "WRITE-addToSet", kind: "WRITE", re: /\$addToSet\s*:\s*\{[^}]*\bhistory\b/ },
  { id: "WRITE-unset", kind: "WRITE", re: /\$unset\s*:\s*\{[^}]*\bhistory\b/ },
  { id: "WRITE-set-dotted", kind: "WRITE", re: /\$set\s*:\s*\{[^}]*["'`]history\./ },
  { id: "WRITE-arrayFilters", kind: "WRITE", re: /["'`]history\.\$\[/ },
  { id: "QUERY-dotted", kind: "QUERY", re: /["'`]history\./ },
  { id: "QUERY-operator", kind: "QUERY", re: /\bhistory\s*:\s*\{\s*\$(size|exists|ne|in|regex|elemMatch|all)/ },
  { id: "PROJECTION", kind: "PROJECTION", re: /project(ion)?\s*\([^)]*\bhistory\b|\bhistory\s*:\s*1\b/ },
  { id: "TRUNCATED", kind: "TRUNCATED", re: /\btruncatedHistory\b/ },
  { id: "ASSIGN-dotted", kind: "ASSIGN", re: /\.history\s*\[[^\]]+\]\s*\.?[A-Za-z_$]*\s*=/ },
  {
    id: "READ-array-op",
    kind: "READ",
    re: /\.history\s*(\?\.[a-zA-Z]*(map|filter|find|findIndex|some|every|forEach|slice|splice|push|concat|reduce|length)|\.[a-zA-Z]*(map|filter|find|findIndex|some|every|forEach|slice|splice|push|concat|reduce|length))/,
  },
  { id: "READ-prop", kind: "READ", re: /[A-Za-z_$][\w$]*\.history\b/ },
  { id: "READ-destructure", kind: "READ", re: /\{[^}]*\bhistory\b[^}]*\}\s*=|\bhistory\b\s*[,}]\s*$/ },
];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
};

const isTest = (file: string) => /__tests__|\.test\.|\.spec\./.test(file);
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

interface Hit {
  rule: string;
  kind: string;
  file: string;
  line: number;
  comment: boolean;
  test: boolean;
  text: string;
}

const hits: Hit[] = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  scanned += 1;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      hits.push({
        rule: rule.id,
        kind: rule.kind,
        file: file.replace(ROOT, "").replace(/^\//, ""),
        line: index + 1,
        comment: isComment(line),
        test: isTest(file),
        text: line.trim().slice(0, 150),
      });
      return;
    }
  });
}

const production = hits.filter((hit) => !hit.test && !hit.comment);

const byKind: Record<string, number> = {};
const byRule: Record<string, number> = {};
for (const hit of hits) {
  byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1;
  byRule[hit.rule] = (byRule[hit.rule] ?? 0) + 1;
}

fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, scanned, total: hits.length, byKind, byRule, hits }, null, 2),
  "utf8"
);

console.log(`root                     : ${ROOT}`);
console.log(`scanned files            : ${scanned}`);
console.log(`total matches            : ${hits.length}`);
console.log(`  in comments            : ${hits.filter((h) => h.comment).length}`);
console.log(`  in tests               : ${hits.filter((h) => h.test).length}`);
console.log(`  PRODUCTION (non-comment): ${production.length}`);
console.log("");
console.log("by kind (QUERY / WRITE / ASSIGN / PROJECTION fail SILENTLY once the array is gone):");
for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(12)} ${count}`);
}
console.log("");
console.log(`full report: ${OUT}`);
console.log("");
console.log("Every hit is a CANDIDATE. Triage each: is it the conversation array, or an unrelated");
console.log("`history` (window.history, a Slack API path, a playwright session, a form field mapping)?");

if (SHOW_ALL) {
  console.log("");
  console.log("--- ALL production hits ---");
  for (const hit of production) {
    console.log(`${hit.file}:${hit.line}  [${hit.kind}]  ${hit.text}`);
  }
}
