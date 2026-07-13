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

const TYPE_RE = /\b(class|interface|struct|enum)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?(?:\s*:\s*([^{]*?))?\s*\{/g;

const splitTypeList = (s: string): string[] =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** C# convention: `IXxx` names are interfaces. */
const isInterfaceName = (name: string): boolean => /^I[A-Z]/.test(cleanTypeName(name));

/**
 * Heuristic C# analyzer. Scans sanitised source for type declarations, members,
 * base-type lists (`: Base, IFoo`), `using` dependencies and calls. Base vs
 * interface is disambiguated by the `IXxx` naming convention (a heuristic, since
 * the true distinction needs full symbol resolution).
 */
export const analyseCSharpFile = (
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
    context?.warn(`CSharpAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  const sanitized = sanitizeCLike(raw);

  // ---- usings ----
  raw.split("\n").forEach((line) => {
    const m = line.match(/^\s*using\s+(?:(static)\s+)?([\w.]+)(?:\s*=\s*([\w.]+))?\s*;/);
    if (!m) return;
    const isStatic = !!m[1];
    const alias = m[3] ? m[2] : undefined; // `using Alias = Ns.Type;`
    const target = m[3] || m[2];
    const externalId = emitter.addExternal(target, `cs:${target}`);
    emitter.addImportExternalEdge(externalId, target, target, [target]);
    if (alias) emitter.bindExternal(alias, externalId);
    else if (isStatic) emitter.bindExternal(target.split(".").pop()!, externalId);
  });

  // ---- type declarations ----
  const types: BraceType[] = [];
  let tm: RegExpExecArray | null;
  TYPE_RE.lastIndex = 0;
  while ((tm = TYPE_RE.exec(sanitized)) !== null) {
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
    TYPE_RE.lastIndex = bodyEnd;
  }

  emitBraceTypes(emitter, sanitized, types);
  return emitter.finish();
};

export default analyseCSharpFile;
