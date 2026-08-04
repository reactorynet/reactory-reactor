/**
 * Legacy regex/brace-scanning analyzers for Java and C#, preserved verbatim
 * as a fallback path for `JavaAnalyzer.ts` / `CSharpAnalyzer.ts`.
 *
 * These are used only when the corresponding tree-sitter grammar (or tree-
 * sitter core itself) is unavailable in the runtime environment, or when
 * parsing throws — see `treesitter/TreeSitterEngine.ts`. This guarantees the
 * Phase 0 tree-sitter upgrade can never *regress* symbol/edge coverage below
 * what the system already produced; it can only add fidelity where the
 * native grammar is installed.
 *
 * Known limitations (documented here as the reason the tree-sitter path
 * exists — see JavaAnalyzer.ts / CSharpAnalyzer.ts for the fix):
 *  - Constructors are intentionally not surfaced as methods (no return type
 *    makes them indistinguishable from other constructs via regex alone).
 *  - C# base-type classification uses the `IXxx` naming convention for EVERY
 *    entry in a base list, which can misclassify interfaces that don't
 *    follow the convention, and can't use the grammar-guaranteed fact that
 *    only the first entry in a class's base list can possibly be a base
 *    class (struct/interface base lists are always 100% interfaces).
 *  - Call-expression matching is a bare regex over sanitized text.
 */
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
  cleanTypeName,
} from "./support";

const JAVA_TYPE_RE = /\b(class|interface|enum)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?([^{;]*)\{/g;
const CSHARP_TYPE_RE =
  /\b(class|interface|struct|enum)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?(?:\s*:\s*([^{]*?))?\s*\{/g;

const splitTypeList = (s: string): string[] =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** C# convention: `IXxx` names are interfaces. */
const isInterfaceName = (name: string): boolean => /^I[A-Z]/.test(cleanTypeName(name));

export const analyseJavaFileLegacy = (
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
    context?.warn(`JavaAnalyzer(legacy): cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  const sanitized = sanitizeCLike(raw);

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

  const types: BraceType[] = [];
  let tm: RegExpExecArray | null;
  JAVA_TYPE_RE.lastIndex = 0;
  while ((tm = JAVA_TYPE_RE.exec(sanitized)) !== null) {
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
    JAVA_TYPE_RE.lastIndex = bodyEnd;
  }

  emitBraceTypes(emitter, sanitized, types);
  return emitter.finish();
};

export const analyseCSharpFileLegacy = (
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
    context?.warn(`CSharpAnalyzer(legacy): cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  const sanitized = sanitizeCLike(raw);

  raw.split("\n").forEach((line) => {
    const m = line.match(/^\s*using\s+(?:(static)\s+)?([\w.]+)(?:\s*=\s*([\w.]+))?\s*;/);
    if (!m) return;
    const isStatic = !!m[1];
    const alias = m[3] ? m[2] : undefined;
    const target = m[3] || m[2];
    const externalId = emitter.addExternal(target, `cs:${target}`);
    emitter.addImportExternalEdge(externalId, target, target, [target]);
    if (alias) emitter.bindExternal(alias, externalId);
    else if (isStatic) emitter.bindExternal(target.split(".").pop()!, externalId);
  });

  const types: BraceType[] = [];
  let tm: RegExpExecArray | null;
  CSHARP_TYPE_RE.lastIndex = 0;
  while ((tm = CSHARP_TYPE_RE.exec(sanitized)) !== null) {
    const kind = tm[1] as BraceType["kind"];
    const name = tm[2];
    const bases = tm[3] ? splitTypeList(tm[3]) : [];
    const bodyOpen = tm.index + tm[0].length - 1;
    const bodyEnd = matchBrace(sanitized, bodyOpen);

    const inherits: string[] = [];
    const implement: string[] = [];
    bases.forEach((b) => (isInterfaceName(b) ? implement.push(b) : inherits.push(b)));

    types.push({
      kind,
      name,
      inherits,
      implements: implement,
      bodyOpen,
      bodyEnd,
      line: lineAt(sanitized, tm.index),
    });
    CSHARP_TYPE_RE.lastIndex = bodyEnd;
  }

  emitBraceTypes(emitter, sanitized, types);
  return emitter.finish();
};
