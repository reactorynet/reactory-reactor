import fs from "fs";
import Parser from "tree-sitter";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode, ReactorNodeType, ReactorLinkType } from "../../../types/model.types";
import { FileAnalysis, GraphEmitter } from "./support";
import {
  parseSource,
  lineOf,
  namedChildrenOfType,
  collectDescendants,
  cleanTypeName,
} from "./treesitter/TreeSitterEngine";

/**
 * Tree-sitter based Java analyzer (Phase 0 determinism upgrade).
 *
 * Replaces the previous regex/brace-counting heuristic with a real AST
 * (tree-sitter-java). This directly fixes three known gaps in the old
 * analyzer:
 *  - Constructors are now real symbols (previously explicitly excluded).
 *  - `new Foo()` produces a CALL edge to the constructor when resolvable
 *    (previously impossible with a bare-regex call scanner).
 *  - Type declarations, extends/implements clauses and members are read from
 *    real grammar nodes instead of a brace-matching regex, so nested types,
 *    generics and multi-line declarations are handled correctly.
 *
 * Ceiling (documented, not hidden): this is still syntax-only. It cannot
 * resolve cross-file/cross-jar symbol references (an unqualified import's
 * actual package member, overload resolution, or whether an *external*
 * unresolved base type is a class or interface) - that requires a real
 * classpath-aware frontend (JavaParser + SymbolSolver), which is the planned
 * opt-in Phase 2 "SDK route" surfaced as a catalogProject option.
 *
 * Node/edge output shape and id-space are unchanged (FileAnalysis, via the
 * shared GraphEmitter), so no downstream persistence/GraphQL code needs to
 * change to pick this up.
 */

type TypeKind = "class" | "interface" | "enum" | "record" | "annotation";

const TYPE_DECL_TYPES = [
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
];

const BODY_TYPES = [
  "class_body",
  "interface_body",
  "enum_body",
  "record_body",
  "annotation_type_body",
];

const kindForNodeType = (nodeType: string): TypeKind => {
  switch (nodeType) {
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "record_declaration":
      return "record";
    case "annotation_type_declaration":
      return "annotation";
    default:
      return "class";
  }
};

interface JavaTypeInfo {
  node: Parser.SyntaxNode;
  name: string;
  kind: TypeKind;
  qualifier?: string; // parent type name, for nested types e.g. "Outer"
  /** Base class (extends) - Java classes have at most one. */
  inherits: string[];
  /** Interfaces implemented/extended - one or many. */
  implements: string[];
}

/** Extract dotted-name text from an import_declaration node's own text. */
const parseImportText = (raw: string): { path: string; wildcard: boolean; isStatic: boolean } => {
  const trimmed = raw.trim().replace(/;$/, "");
  const isStatic = /^import\s+static\s+/.test(trimmed);
  const rest = trimmed.replace(/^import\s+(static\s+)?/, "").trim();
  const wildcard = rest.endsWith(".*");
  const path = wildcard ? rest.slice(0, -2) : rest;
  return { path, wildcard, isStatic };
};

/** Collect the type_identifier/scoped_type_identifier texts from a type_list node. */
const typeListNames = (typeListNode: Parser.SyntaxNode | null): string[] => {
  if (!typeListNode) return [];
  return typeListNode.namedChildren.map((c) => cleanTypeName(c.text));
};

/**
 * Discover all type declarations (including nested ones) with their
 * inheritance clauses, qualifying nested type names as `Outer.Inner`.
 */
const collectTypes = (root: Parser.SyntaxNode): JavaTypeInfo[] => {
  const results: JavaTypeInfo[] = [];

  const visit = (node: Parser.SyntaxNode, qualifier?: string) => {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? nameNode.text : "<anonymous>";
    const kind = kindForNodeType(node.type);

    let inherits: string[] = [];
    let implementsList: string[] = [];

    if (node.type === "class_declaration" || node.type === "record_declaration") {
      const superclassNode = node.childForFieldName("superclass");
      if (superclassNode) {
        // superclass: (superclass (type_identifier)) - take the wrapped type text.
        const typeNode = superclassNode.namedChildren[0];
        if (typeNode) inherits = [cleanTypeName(typeNode.text)];
      }
      const interfacesNode = node.childForFieldName("interfaces");
      if (interfacesNode) {
        // interfaces: (super_interfaces (type_list ...))
        const typeList = interfacesNode.namedChildren.find((c) => c.type === "type_list");
        implementsList = typeListNames(typeList || null);
      }
    } else if (node.type === "interface_declaration") {
      const interfacesNode = node.childForFieldName("interfaces");
      if (interfacesNode && interfacesNode.type === "extends_interfaces") {
        // An interface's `extends` list is semantically inheritance (interface
        // extends interface), not implementation.
        const typeList = interfacesNode.namedChildren.find((c) => c.type === "type_list");
        inherits = typeListNames(typeList || null);
      }
    } else if (node.type === "enum_declaration") {
      const interfacesNode = node.childForFieldName("interfaces");
      if (interfacesNode) {
        const typeList = interfacesNode.namedChildren.find((c) => c.type === "type_list");
        implementsList = typeListNames(typeList || null);
      }
    }

    results.push({ node, name, kind, qualifier, inherits, implements: implementsList });

    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        if (TYPE_DECL_TYPES.includes(child.type)) {
          visit(child, qualifier ? `${qualifier}.${name}` : name);
        }
      }
    }
  };

  for (const child of root.namedChildren) {
    if (TYPE_DECL_TYPES.includes(child.type)) visit(child);
  }
  return results;
};

/** Direct (non-nested) members of a type's body: methods + constructors. */
const directMembers = (
  bodyNode: Parser.SyntaxNode
): { kind: "method" | "constructor"; node: Parser.SyntaxNode; name: string }[] => {
  const out: { kind: "method" | "constructor"; node: Parser.SyntaxNode; name: string }[] = [];
  for (const child of bodyNode.namedChildren) {
    if (child.type === "method_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) out.push({ kind: "method", node: child, name: nameNode.text });
    } else if (child.type === "constructor_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) out.push({ kind: "constructor", node: child, name: nameNode.text });
    }
  }
  return out;
};

/** Extract call-like references (method_invocation, object_creation_expression) in a subtree. */
interface JavaCallRef {
  kind: "invocation" | "construction";
  receiver?: string; // "this" | identifier | undefined (bare call)
  name: string; // method name, or constructed type name
}

const extractCalls = (node: Parser.SyntaxNode): JavaCallRef[] => {
  const refs: JavaCallRef[] = [];
  const invocations = collectDescendants(
    node,
    ["method_invocation", "object_creation_expression"],
    TYPE_DECL_TYPES // don't descend into nested type declarations
  );
  for (const inv of invocations) {
    if (inv.type === "method_invocation") {
      const nameNode = inv.childForFieldName("name");
      if (!nameNode) continue;
      const objectNode = inv.childForFieldName("object");
      if (!objectNode) {
        refs.push({ kind: "invocation", name: nameNode.text });
      } else if (objectNode.type === "this") {
        refs.push({ kind: "invocation", receiver: "this", name: nameNode.text });
      } else if (objectNode.type === "super") {
        refs.push({ kind: "invocation", receiver: "super", name: nameNode.text });
      } else if (objectNode.type === "identifier") {
        refs.push({ kind: "invocation", receiver: objectNode.text, name: nameNode.text });
      }
      // Other receiver shapes (chained calls, casts) intentionally produce no
      // edge rather than a guess.
    } else if (inv.type === "object_creation_expression") {
      const typeNode = inv.childForFieldName("type");
      if (typeNode) refs.push({ kind: "construction", name: cleanTypeName(typeNode.text) });
    }
  }
  return refs;
};

export const analyseJavaFile = async (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext
): Promise<FileAnalysis> => {
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

  let root: Parser.SyntaxNode;
  try {
    const parsed = await parseSource("java", raw);
    root = parsed.rootNode;
    if (parsed.hasError) {
      context?.warn(`JavaAnalyzer: parse errors in ${filePath}; results may be partial`);
    }
  } catch (err) {
    context?.warn(`JavaAnalyzer: tree-sitter parse failed for ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  // ---- imports ----
  const importNodes = namedChildrenOfType(root, ["import_declaration"]);
  for (const imp of importNodes) {
    const { path: full, wildcard, isStatic } = parseImportText(imp.text);
    if (!full) continue;
    const externalId = emitter.addExternal(full, `java:${full}`);
    emitter.addImportExternalEdge(externalId, full, full, [full]);
    if (!wildcard) {
      const simple = full.split(".").pop()!;
      emitter.bindExternal(simple, externalId);
    } else if (isStatic) {
      // `import static pkg.Type.*` - nothing more specific to bind.
    }
  }

  // ---- type declarations (incl. nested) ----
  const types = collectTypes(root);
  const typeNodeByQualifiedName = new Map<string, ReactorNode>();
  const kindByName = new Map<string, TypeKind>(); // simple-name -> kind, for local resolution

  for (const t of types) kindByName.set(t.name, t.kind);

  // Pass 1: register type symbols so method/inheritance resolution can find them.
  for (const t of types) {
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    const nodeType =
      t.kind === "interface" || t.kind === "enum" || t.kind === "annotation"
        ? ReactorNodeType.CHILD
        : ReactorNodeType.PROCESS;
    const parentSymbol = t.qualifier ? typeNodeByQualifiedName.get(t.qualifier) : undefined;
    const symbolNode = emitter.addSymbol(t.name, t.kind, nodeType, lineOf(t.node), {
      qualifier: t.qualifier,
      parent: parentSymbol,
    });
    typeNodeByQualifiedName.set(symbolPath, symbolNode);
  }

  // Pass 2: methods + constructors (direct members only; nested types handled
  // as their own entries in `types`).
  const callSites: { symbolPath: string; typeName: string; bodyNode: Parser.SyntaxNode }[] = [];
  for (const t of types) {
    const body = t.node.childForFieldName("body");
    if (!body) continue;
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    const parentSymbol = typeNodeByQualifiedName.get(symbolPath);
    for (const member of directMembers(body)) {
      const memberSymbolPath = `${symbolPath}.${member.name}`;
      emitter.addSymbol(
        member.name,
        member.kind,
        ReactorNodeType.FUNCTION,
        lineOf(member.node),
        { qualifier: symbolPath, parent: parentSymbol }
      );
      const memberBody = member.node.childForFieldName("body");
      if (memberBody) callSites.push({ symbolPath: memberSymbolPath, typeName: t.name, bodyNode: memberBody });
    }
  }

  // Pass 3: inheritance edges.
  for (const t of types) {
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    t.inherits.forEach((base) => emitter.addInheritanceEdge(symbolPath, base, ReactorLinkType.INHERITS));
    t.implements.forEach((base) => emitter.addInheritanceEdge(symbolPath, base, ReactorLinkType.IMPLEMENTS));
  }

  // Pass 4: calls (including `new X()` construction edges - a real gap fix
  // vs. the previous regex analyzer, which explicitly excluded constructors).
  for (const site of callSites) {
    const refs = extractCalls(site.bodyNode);
    const seen = new Set<string>();
    for (const ref of refs) {
      let targetId: number | null = null;
      let title: string;
      if (ref.kind === "construction") {
        // `new Foo()` -> Foo's constructor symbol if Foo is declared locally.
        title = `new ${ref.name}`;
        targetId =
          emitter.resolveLocalPath(`${ref.name}.${ref.name}`) ?? emitter.resolveName(ref.name);
      } else if (!ref.receiver) {
        title = ref.name;
        targetId =
          emitter.resolveLocalPath(`${site.typeName}.${ref.name}`) ?? emitter.resolveName(ref.name);
      } else if (ref.receiver === "this" || ref.receiver === "super") {
        title = `${ref.receiver}.${ref.name}`;
        targetId = emitter.resolveLocalPath(`${site.typeName}.${ref.name}`);
      } else {
        title = `${ref.receiver}.${ref.name}`;
        targetId = emitter.resolveName(ref.receiver);
      }
      if (targetId === null) continue;
      const key = `${title}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      emitter.addCallEdge(site.symbolPath, title, targetId);
    }
  }

  return emitter.finish();
};

export default analyseJavaFile;
