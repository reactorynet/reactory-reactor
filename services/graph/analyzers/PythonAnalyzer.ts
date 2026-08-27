import fs from "fs";
import path from "path";
import type Parser from "tree-sitter";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode, ReactorNodeType, ReactorLinkType } from "../../../types/model.types";
import { normalizeRelative } from "../GraphIdentity";
import { FileAnalysis, GraphEmitter, extractCallTokens } from "./support";
import {
  parseSource,
  isTreeSitterAvailable,
  lineOf,
  collectDescendants,
  cleanTypeName,
} from "./treesitter/TreeSitterEngine";

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

const makeRelativeResolver = (filePath: string, repoPath: string) => {
  return (dots: number, rest: string): string | null => {
    let baseDir = path.dirname(filePath);
    for (let k = 1; k < dots; k++) baseDir = path.dirname(baseDir);
    const segs = rest ? rest.split(".") : [];
    const p = path.join(baseDir, ...segs);
    const candidates = [`${p}.py`, path.join(p, "__init__.py")];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try {
          if (fs.statSync(c).isFile()) {
            const rel = normalizeRelative(path.relative(repoPath, c));
            if (!rel.startsWith("..")) return rel;
          }
        } catch {
          // ignore stat errors
        }
      }
    }
    return null;
  };
};

/**
 * Heuristic Python analyzer (fallback when tree-sitter is unavailable).
 */
const analysePythonHeuristic = (
  fileNode: ReactorNode,
  raw: string,
  emitter: GraphEmitter
): FileAnalysis => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const repoPath: string = data.repoPath;
  const lines = raw.split("\n");
  const resolveRelative = makeRelativeResolver(filePath, repoPath);

  // ---- Pass 1: imports ----------------------------------------------------
  lines.forEach((rawLine) => {
    const importMatch = rawLine.match(/^\s*import\s+(.+?)\s*$/);
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

    const fromMatch = rawLine.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/);
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

  lines.forEach((rawLine, i) => {
    if (!isCode(rawLine)) return;
    const ind = indentOf(rawLine);
    while (classStack.length && classStack[classStack.length - 1].indent >= ind)
      classStack.pop();

    const classMatch = rawLine.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
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

    const defMatch = rawLine.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
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

interface TreeSitterSymbol {
  kind: "class" | "def";
  node: Parser.SyntaxNode;
  name: string;
  symbolPath: string;
  qualifier?: string;
  className?: string;
  bases?: string[];
  bodyNode?: Parser.SyntaxNode;
}

/**
 * Tree-sitter based Python analyzer (AST precision upgrade).
 */
const analysePythonWithTreeSitter = (
  fileNode: ReactorNode,
  root: Parser.SyntaxNode,
  emitter: GraphEmitter
): FileAnalysis => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const repoPath: string = data.repoPath;
  const resolveRelative = makeRelativeResolver(filePath, repoPath);

  // ---- Pass 1: imports ----
  const importStatements = collectDescendants(root, [
    "import_statement",
    "import_from_statement",
  ]);

  for (const stmt of importStatements) {
    if (stmt.type === "import_statement") {
      for (const child of stmt.namedChildren) {
        if (child.type === "dotted_name") {
          const modName = child.text;
          const externalId = emitter.addExternal(modName, `py:${modName}`);
          emitter.addImportExternalEdge(externalId, modName, modName, [modName]);
          emitter.bindExternal(modName.split(".")[0], externalId);
        } else if (child.type === "aliased_import") {
          const nameNode = child.childForFieldName("name");
          const aliasNode = child.childForFieldName("alias");
          if (nameNode) {
            const modName = nameNode.text;
            const aliasName = aliasNode ? aliasNode.text : modName.split(".")[0];
            const externalId = emitter.addExternal(modName, `py:${modName}`);
            emitter.addImportExternalEdge(externalId, modName, modName, [modName]);
            emitter.bindExternal(aliasName, externalId);
          }
        }
      }
    } else if (stmt.type === "import_from_statement") {
      const moduleNameNode = stmt.childForFieldName("module_name");
      const rawText = stmt.text;

      let dots = 0;
      let modulePath = "";

      if (moduleNameNode) {
        if (moduleNameNode.type === "relative_import") {
          const match = moduleNameNode.text.match(/^(\.+)(.*)$/);
          if (match) {
            dots = match[1].length;
            modulePath = match[2];
          }
        } else {
          modulePath = moduleNameNode.text;
        }
      } else {
        const fromMatch = rawText.match(/^\s*from\s+(\.+)([\w.]*)\s+import/);
        if (fromMatch) {
          dots = fromMatch[1].length;
          modulePath = fromMatch[2];
        }
      }

      const names: { name: string; local: string }[] = [];
      for (const child of stmt.namedChildren) {
        if (child === moduleNameNode) continue;
        if (child.type === "dotted_name" || child.type === "identifier") {
          names.push({ name: child.text, local: child.text });
        } else if (child.type === "aliased_import") {
          const nameNode = child.childForFieldName("name");
          const aliasNode = child.childForFieldName("alias");
          if (nameNode) {
            names.push({
              name: nameNode.text,
              local: aliasNode ? aliasNode.text : nameNode.text,
            });
          }
        }
      }

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
  }

  // ---- Pass 2: collect class and function symbols ----
  const symbols: TreeSitterSymbol[] = [];

  const visitNode = (node: Parser.SyntaxNode, qualifier?: string, enclosingClass?: string) => {
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const symbolPath = qualifier ? `${qualifier}.${name}` : name;
      const superclassesNode = node.childForFieldName("superclasses");
      const bases: string[] = [];
      if (superclassesNode) {
        for (const child of superclassesNode.namedChildren) {
          if (child.type === "identifier" || child.type === "attribute") {
            bases.push(cleanTypeName(child.text));
          }
        }
      }
      symbols.push({
        kind: "class",
        node,
        name,
        symbolPath,
        qualifier,
        bases,
      });

      const bodyNode = node.childForFieldName("body");
      if (bodyNode) {
        for (const child of bodyNode.namedChildren) {
          visitNode(child, symbolPath, symbolPath);
        }
      }
    } else if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const symbolPath = qualifier ? `${qualifier}.${name}` : name;
      const bodyNode = node.childForFieldName("body");
      symbols.push({
        kind: "def",
        node,
        name,
        symbolPath,
        qualifier,
        className: enclosingClass,
        bodyNode,
      });

      if (bodyNode) {
        for (const child of bodyNode.namedChildren) {
          if (child.type === "class_definition" || child.type === "function_definition") {
            visitNode(child, symbolPath, enclosingClass);
          }
        }
      }
    }
  };

  for (const child of root.namedChildren) {
    visitNode(child);
  }

  // ---- Emit symbols ----
  const classNodes = new Map<string, ReactorNode>();
  for (const s of symbols) {
    if (s.kind === "class") {
      const parentNode = s.qualifier ? classNodes.get(s.qualifier) : undefined;
      const node = emitter.addSymbol(s.name, "class", ReactorNodeType.PROCESS, lineOf(s.node), {
        qualifier: s.qualifier,
        parent: parentNode,
      });
      classNodes.set(s.symbolPath, node);
    }
  }

  for (const s of symbols) {
    if (s.kind === "def") {
      const parentNode = s.className ? classNodes.get(s.className) : undefined;
      emitter.addSymbol(
        s.name,
        s.className ? "method" : "function",
        ReactorNodeType.FUNCTION,
        lineOf(s.node),
        { qualifier: s.qualifier, parent: parentNode }
      );
    }
  }

  // ---- Pass 3: inheritance edges ----
  for (const s of symbols) {
    if (s.kind === "class" && s.bases) {
      for (const base of s.bases) {
        if (base === "object") continue;
        const simple = base.split(".").pop()!;
        emitter.addInheritanceEdge(s.symbolPath, simple, ReactorLinkType.INHERITS);
      }
    }
  }

  // ---- Pass 4: call edges ----
  for (const s of symbols) {
    if (s.kind === "def" && s.bodyNode) {
      const calls = collectDescendants(
        s.bodyNode,
        ["call"],
        ["class_definition", "function_definition"]
      );
      const seen = new Set<string>();

      for (const call of calls) {
        const fnNode = call.childForFieldName("function") || call.namedChildren[0];
        if (!fnNode) continue;

        let targetId: number | null = null;
        let title: string = "";

        if (fnNode.type === "identifier") {
          title = fnNode.text;
          targetId = emitter.resolveName(fnNode.text);
        } else if (fnNode.type === "attribute") {
          const objNode = fnNode.childForFieldName("object");
          const attrNode = fnNode.childForFieldName("attribute");
          if (objNode && attrNode) {
            const objText = objNode.text;
            const attrText = attrNode.text;
            if ((objText === "self" || objText === "cls") && s.className) {
              title = `self.${attrText}`;
              targetId = emitter.resolveLocalPath(`${s.className}.${attrText}`);
            } else {
              title = `${objText}.${attrText}`;
              targetId = emitter.resolveName(objText);
            }
          }
        }

        if (targetId !== null) {
          const key = `${title}:${targetId}`;
          if (!seen.has(key)) {
            seen.add(key);
            emitter.addCallEdge(s.symbolPath, title, targetId);
          }
        }
      }
    }
  }

  return emitter.finish();
};

/**
 * Parses Python files into symbols and edges:
 * 1. TreeSitter AST analysis when available.
 * 2. Indentation/regex heuristic scanner as resilient fallback.
 */
export const analysePythonFile = async (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext
): Promise<FileAnalysis> => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const repoPath: string = data.repoPath;
  const emitter = new GraphEmitter(fileNode);

  if (!filePath || !fs.existsSync(filePath) || !repoPath) return emitter.finish();

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    context?.warn(`PythonAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  // 1. Try Tree-sitter AST engine first
  try {
    const isAvail = await isTreeSitterAvailable("python");
    if (isAvail) {
      const parsed = await parseSource("python", raw);
      if (parsed && parsed.rootNode) {
        return analysePythonWithTreeSitter(fileNode, parsed.rootNode, emitter);
      }
    }
  } catch (err) {
    context?.warn(
      `PythonAnalyzer: tree-sitter parse failed for ${filePath}: ${(err as Error).message}; falling back to heuristic`
    );
  }

  // 2. Fall back to heuristic engine
  return analysePythonHeuristic(fileNode, raw, emitter);
};

export default analysePythonFile;
