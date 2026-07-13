import fs from "fs";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode } from "../../../types/model.types";
import {
  FileAnalysis,
  GraphEmitter,
  BraceType,
  emitBraceTypes,
  sanitizeCLike,
  matchBrace,
  lineAt,
} from "./support";

const TYPE_RE = /\b(class|interface|enum)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?([^{;]*)\{/g;

const splitTypeList = (s: string): string[] =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Heuristic Java analyzer. No Java AST parser is available in this runtime, so
 * this scans comment/string-sanitised source for type declarations, members,
 * `extends`/`implements` inheritance, `import` dependencies and method calls.
 * Constructors (no return type) are intentionally not surfaced as methods.
 */
export const analyseJavaFile = (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext
): FileAnalysis => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const emitter = new GraphEmitter(fileNode);
  if (!filePath || !fs.existsSync(filePath)) return emitter.finish();

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    context?.warn(`JavaAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  const sanitized = sanitizeCLike(raw);

  // ---- imports ----
  raw.split("\n").forEach((line) => {
    const m = line.match(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/);
    if (!m) return;
    const full = m[1] + (m[2] || "");
    const externalId = emitter.addExternal(full, `java:${full}`);
    emitter.addImportExternalEdge(externalId, full, full, [full]);
    if (!m[2]) {
      const simple = m[1].split(".").pop()!;
      emitter.bindExternal(simple, externalId);
    }
  });

  // ---- type declarations ----
  const types: BraceType[] = [];
  let tm: RegExpExecArray | null;
  TYPE_RE.lastIndex = 0;
  while ((tm = TYPE_RE.exec(sanitized)) !== null) {
    const kind = tm[1] as BraceType["kind"];
    const name = tm[2];
    const clause = tm[3] || "";
    const bodyOpen = tm.index + tm[0].length - 1;
    const bodyEnd = matchBrace(sanitized, bodyOpen);

    const extMatch = clause.match(/extends\s+([\w.<>,\s]+?)(?:\bimplements\b|$)/);
    const implMatch = clause.match(/implements\s+([\w.<>,\s]+)$/);

    types.push({
      kind,
      name,
      inherits: extMatch ? splitTypeList(extMatch[1]) : [],
      implements: implMatch ? splitTypeList(implMatch[1]) : [],
      bodyOpen,
      bodyEnd,
      line: lineAt(sanitized, tm.index),
    });
    TYPE_RE.lastIndex = bodyEnd; // don't descend into the body for the next type match
  }

  emitBraceTypes(emitter, sanitized, types);
  return emitter.finish();
};

export default analyseJavaFile;
