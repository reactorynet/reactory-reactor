import fs from "fs";
import path from "path";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode, ReactorNodeType, ReactorLinkType } from "../../../types/model.types";
import { normalizeRelative } from "../GraphIdentity";
import { FileAnalysis, GraphEmitter, extractCallTokens } from "./support";

const indentOf = (line: string): number =>
  (line.match(/^[ \t]*/)?.[0] || "").replace(/\t/g, "    ").length;

const isCode = (line: string): boolean => {
  const t = line.trim();
  return t.length > 0 && !t.startsWith("#");
};

interface Decl {
  kind: "class" | "def";
  name: string;
  symbolPath: string;
  indent: number;
  line: number; // 1-based
  index: number; // 0-based line index
  className?: string;
  bases?: string[];
}

/**
 * Heuristic Python analyzer. Python has no AST parser available in this runtime,
 * so this is an indentation-aware line scanner. It extracts classes, functions
 * and methods, `import`/`from … import` dependencies, base-class inheritance
 * (INHERITS), and calls (CALL). Names that don't resolve to a local symbol or
 * import binding (builtins, keywords) produce no edge, which naturally filters
 * noise.
 */
export const analysePythonFile = (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext
): FileAnalysis => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const repoPath: string = data.repoPath;
  const emitter = new GraphEmitter(fileNode);

  if (!filePath || !fs.existsSync(filePath) || !repoPath) return emitter.finish();

  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf-8").split("\n");
  } catch (err) {
    context?.warn(`PythonAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  const resolveRelative = (dots: number, rest: string): string | null => {
    let baseDir = path.dirname(filePath);
    for (let k = 1; k < dots; k++) baseDir = path.dirname(baseDir);
    const segs = rest ? rest.split(".") : [];
    const p = path.join(baseDir, ...segs);
    const candidates = [`${p}.py`, path.join(p, "__init__.py")];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        const rel = normalizeRelative(path.relative(repoPath, c));
        if (!rel.startsWith("..")) return rel;
      }
    }
    return null;
  };

  // ---- Pass 1: imports ----------------------------------------------------
  lines.forEach((raw) => {
    const importMatch = raw.match(/^\s*import\s+(.+?)\s*$/);
    if (importMatch) {
      importMatch[1].split(",").forEach((part) => {
        const [modRaw, aliasRaw] = part.split(/\s+as\s+/).map((s) => s.trim());
        if (!modRaw) return;
        const externalId = emitter.addExternal(modRaw, `py:${modRaw}`);
        emitter.addImportExternalEdge(externalId, modRaw, modRaw, [modRaw]);
        emitter.bindExternal(aliasRaw || modRaw.split(".")[0], externalId);
      });
      return;
    }

    const fromMatch = raw.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/);
    if (fromMatch) {
      const dots = fromMatch[1].length;
      const modulePath = fromMatch[2];
      const names = fromMatch[3]
        .replace(/[()]/g, "")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/))
        .filter((p) => p[0] && p[0] !== "*")
        .map(([n, alias]) => ({ name: n, local: alias || n }));

      if (dots > 0) {
        if (modulePath) {
          const targetRel = resolveRelative(dots, modulePath);
          if (targetRel) {
            emitter.addImportFileEdge(
              targetRel,
              `${".".repeat(dots)}${modulePath}`,
              names.map((n) => n.name)
            );
            names.forEach((n) => emitter.bindFile(n.local, targetRel));
          }
        } else {
          // `from . import mod, other`
          names.forEach((n) => {
            const targetRel = resolveRelative(dots, n.name);
            if (targetRel) {
              emitter.addImportFileEdge(targetRel, `${".".repeat(dots)}${n.name}`, [n.name]);
              emitter.bindFile(n.local, targetRel);
            }
          });
        }
      } else if (modulePath) {
        const externalId = emitter.addExternal(modulePath, `py:${modulePath}`);
        emitter.addImportExternalEdge(
          externalId,
          modulePath,
          modulePath,
          names.map((n) => n.name)
        );
        names.forEach((n) => emitter.bindExternal(n.local, externalId));
      }
    }
  });

  // ---- Pass 2: collect declarations (indentation-aware) -------------------
  const decls: Decl[] = [];
  const classStack: { indent: number; name: string }[] = [];

  lines.forEach((raw, i) => {
    if (!isCode(raw)) return;
    const ind = indentOf(raw);
    while (classStack.length && classStack[classStack.length - 1].indent >= ind)
      classStack.pop();

    const classMatch = raw.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const name = classMatch[1];
      const bases = (classMatch[2] || "")
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      decls.push({ kind: "class", name, symbolPath: name, indent: ind, line: i + 1, index: i, bases });
      classStack.push({ indent: ind, name });
      return;
    }

    const defMatch = raw.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (defMatch) {
      const name = defMatch[1];
      const enclosing = classStack[classStack.length - 1];
      const className = enclosing?.name;
      const symbolPath = className ? `${className}.${name}` : name;
      decls.push({ kind: "def", name, symbolPath, indent: ind, line: i + 1, index: i, className });
    }
  });

  // ---- Emit symbols (classes first so methods can parent onto them) -------
  const classNodes = new Map<string, ReactorNode>();
  decls
    .filter((d) => d.kind === "class")
    .forEach((d) => {
      classNodes.set(d.name, emitter.addSymbol(d.name, "class", ReactorNodeType.PROCESS, d.line));
    });
  decls
    .filter((d) => d.kind === "def")
    .forEach((d) => {
      emitter.addSymbol(
        d.name,
        d.className ? "method" : "function",
        ReactorNodeType.FUNCTION,
        d.line,
        { qualifier: d.className, parent: d.className ? classNodes.get(d.className) : undefined }
      );
    });

  // ---- Inheritance --------------------------------------------------------
  decls
    .filter((d) => d.kind === "class" && d.bases && d.bases.length)
    .forEach((d) => {
      d.bases!.forEach((base) => {
        // object is Python's implicit root; ignore it.
        if (base === "object") return;
        const simple = base.split(".").pop()!;
        emitter.addInheritanceEdge(d.name, simple, ReactorLinkType.INHERITS);
      });
    });

  // ---- Calls --------------------------------------------------------------
  const bodyEnd = (start: number, indent: number): number => {
    for (let j = start + 1; j < lines.length; j++) {
      if (isCode(lines[j]) && indentOf(lines[j]) <= indent) return j;
    }
    return lines.length;
  };

  decls
    .filter((d) => d.kind === "def")
    .forEach((d) => {
      const end = bodyEnd(d.index, d.indent);
      const body = lines.slice(d.index + 1, end).join("\n");
      const tokens = extractCallTokens(body);
      const seen = new Set<string>();
      tokens.forEach((tok) => {
        let targetId: number | null = null;
        let title = tok.name;
        if (tok.kind === "member") {
          if ((tok.receiver === "self" || tok.receiver === "cls") && d.className) {
            title = `self.${tok.name}`;
            targetId = emitter.resolveLocalPath(`${d.className}.${tok.name}`);
          } else if (tok.receiver) {
            title = `${tok.receiver}.${tok.name}`;
            targetId = emitter.resolveName(tok.receiver);
          }
        } else {
          targetId = emitter.resolveName(tok.name);
        }
        if (targetId === null) return;
        const dedupe = `${title}:${targetId}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        emitter.addCallEdge(d.symbolPath, title, targetId);
      });
    });

  return emitter.finish();
};

export default analysePythonFile;
