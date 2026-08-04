import fs from "fs";
import Parser from "tree-sitter";
import Reactory from "@reactorynet/reactory-core";
import { ReactorNode, ReactorNodeType, ReactorLinkType } from "../../../types/model.types";
import { FileAnalysis, GraphEmitter } from "./support";
import {
  parseSource,
  lineOf,
  collectDescendants,
  cleanTypeName,
} from "./treesitter/TreeSitterEngine";

/**
 * Tree-sitter based C# analyzer (Phase 0 determinism upgrade).
 *
 * Replaces the previous regex/brace-counting heuristic AND retires the
 * `isInterfaceName` (`/^I[A-Z]/`) naming-convention guess for same-file base
 * types: tree-sitter-c-sharp gives distinct `interface_declaration` /
 * `class_declaration` / `struct_declaration` node types, so when a base type
 * is declared in the same file we now know its true kind - no naming
 * convention required. For a `struct`, only interfaces are legal in the base
 * list (a real C# language rule), so that classification is deterministic
 * regardless of naming.
 *
 * Constructors are now real symbols (previously dropped), and `new Foo()`
 * yields a CALL edge to the constructor when resolvable.
 *
 * Ceiling (documented, not hidden): a base type declared in *another file or
 * assembly* still has no reliable way to know its true kind from syntax
 * alone (e.g. `class Bar : Base` where `Base` isn't declared locally) - the
 * IXxx naming convention is retained ONLY as an explicit last-resort fallback
 * for such unresolved references, and the edge is tagged `data.resolved` so
 * callers can tell a syntactic guess from a locally-verified fact. True
 * cross-assembly resolution is the planned Phase 2 "SDK route" (Roslyn
 * `MSBuildWorkspace` + `SemanticModel`), opt-in via catalogProject.
 */

type TypeKind = "class" | "interface" | "struct" | "enum";

const TYPE_DECL_TYPES = [
  "class_declaration",
  "interface_declaration",
  "struct_declaration",
  "enum_declaration",
];

const kindForNodeType = (nodeType: string): TypeKind => {
  switch (nodeType) {
    case "interface_declaration":
      return "interface";
    case "struct_declaration":
      return "struct";
    case "enum_declaration":
      return "enum";
    default:
      return "class";
  }
};

interface CSharpTypeInfo {
  node: Parser.SyntaxNode;
  name: string;
  kind: TypeKind;
  qualifier?: string;
  /** Raw base-list entries (not yet classified INHERITS vs IMPLEMENTS). */
  bases: string[];
}

/** Fallback naming convention, used ONLY for bases that can't be resolved locally. */
const looksLikeInterfaceName = (name: string): boolean => /^I[A-Z]/.test(cleanTypeName(name));

const baseListNames = (typeNode: Parser.SyntaxNode): string[] => {
  const baseList = typeNode.namedChildren.find((c) => c.type === "base_list");
  if (!baseList) return [];
  return baseList.namedChildren.map((c) => cleanTypeName(c.text));
};

/**
 * Discover all type declarations (including nested ones - C# allows nested
 * classes/interfaces), qualifying nested names as `Outer.Inner`. Walks
 * through namespace_declaration transparently (namespaces aren't symbols
 * here, matching the previous analyzer's flat symbol model).
 */
const collectTypes = (root: Parser.SyntaxNode): CSharpTypeInfo[] => {
  const results: CSharpTypeInfo[] = [];

  const visitContainer = (container: Parser.SyntaxNode, qualifier?: string) => {
    for (const child of container.namedChildren) {
      if (child.type === "namespace_declaration" || child.type === "file_scoped_namespace_declaration") {
        const body = child.childForFieldName("body") || child;
        visitContainer(body, qualifier);
      } else if (TYPE_DECL_TYPES.includes(child.type)) {
        visitType(child, qualifier);
      }
    }
  };

  const visitType = (node: Parser.SyntaxNode, qualifier?: string) => {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? nameNode.text : "<anonymous>";
    const kind = kindForNodeType(node.type);
    const bases = baseListNames(node);

    results.push({ node, name, kind, qualifier, bases });

    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        if (TYPE_DECL_TYPES.includes(child.type)) {
          visitType(child, qualifier ? `${qualifier}.${name}` : name);
        }
      }
    }
  };

  visitContainer(root);
  return results;
};

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

interface CSharpCallRef {
  kind: "invocation" | "construction";
  receiver?: string;
  name: string;
}

const extractCalls = (node: Parser.SyntaxNode): CSharpCallRef[] => {
  const refs: CSharpCallRef[] = [];
  const invocations = collectDescendants(
    node,
    ["invocation_expression", "object_creation_expression"],
    TYPE_DECL_TYPES
  );
  for (const inv of invocations) {
    if (inv.type === "invocation_expression") {
      const fn = inv.childForFieldName("function");
      if (!fn) continue;
      if (fn.type === "identifier") {
        refs.push({ kind: "invocation", name: fn.text });
      } else if (fn.type === "member_access_expression") {
        const nameNode = fn.childForFieldName("name");
        const exprNode = fn.childForFieldName("expression");
        if (!nameNode) continue;
        if (!exprNode || exprNode.type === "this_expression") {
          refs.push({ kind: "invocation", receiver: "this", name: nameNode.text });
        } else if (exprNode.type === "base_expression") {
          refs.push({ kind: "invocation", receiver: "base", name: nameNode.text });
        } else if (exprNode.type === "identifier") {
          refs.push({ kind: "invocation", receiver: exprNode.text, name: nameNode.text });
        }
        // Other receiver shapes (chained/cast) intentionally produce no edge.
      }
    } else if (inv.type === "object_creation_expression") {
      const typeNode = inv.childForFieldName("type");
      if (typeNode) refs.push({ kind: "construction", name: cleanTypeName(typeNode.text) });
    }
  }
  return refs;
};

export const analyseCSharpFile = async (
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
    context?.warn(`CSharpAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  let root: Parser.SyntaxNode;
  try {
    const parsed = await parseSource("csharp", raw);
    root = parsed.rootNode;
    if (parsed.hasError) {
      context?.warn(`CSharpAnalyzer: parse errors in ${filePath}; results may be partial`);
    }
  } catch (err) {
    context?.warn(`CSharpAnalyzer: tree-sitter parse failed for ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  // ---- usings ----
  for (const imp of root.namedChildren.filter((c) => c.type === "using_directive")) {
    const raw = imp.text.trim().replace(/;$/, "");
    const isStatic = /^using\s+static\s+/.test(raw);
    const rest = raw.replace(/^using\s+(static\s+)?/, "").trim();
    const aliasMatch = rest.match(/^([\w.]+)\s*=\s*([\w.<>]+)$/);
    const alias = aliasMatch ? aliasMatch[1] : undefined;
    const target = aliasMatch ? aliasMatch[2] : rest;
    if (!target) continue;
    const externalId = emitter.addExternal(target, `cs:${target}`);
    emitter.addImportExternalEdge(externalId, target, target, [target]);
    if (alias) emitter.bindExternal(alias, externalId);
    else if (isStatic) emitter.bindExternal(cleanTypeName(target), externalId);
  }

  // ---- type declarations (incl. nested, incl. namespace-transparent) ----
  const types = collectTypes(root);
  const kindByName = new Map<string, TypeKind>();
  for (const t of types) kindByName.set(t.name, t.kind);

  const typeNodeByQualifiedName = new Map<string, ReactorNode>();

  // Pass 1: register type symbols.
  for (const t of types) {
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    const nodeType =
      t.kind === "interface" || t.kind === "enum" ? ReactorNodeType.CHILD : ReactorNodeType.PROCESS;
    const parentSymbol = t.qualifier ? typeNodeByQualifiedName.get(t.qualifier) : undefined;
    const symbolNode = emitter.addSymbol(t.name, t.kind, nodeType, lineOf(t.node), {
      qualifier: t.qualifier,
      parent: parentSymbol,
    });
    typeNodeByQualifiedName.set(symbolPath, symbolNode);
  }

  // Pass 2: methods + constructors.
  const callSites: { symbolPath: string; typeName: string; bodyNode: Parser.SyntaxNode }[] = [];
  for (const t of types) {
    const body = t.node.childForFieldName("body");
    if (!body) continue;
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    const parentSymbol = typeNodeByQualifiedName.get(symbolPath);
    for (const member of directMembers(body)) {
      const memberSymbolPath = `${symbolPath}.${member.name}`;
      emitter.addSymbol(member.name, member.kind, ReactorNodeType.FUNCTION, lineOf(member.node), {
        qualifier: symbolPath,
        parent: parentSymbol,
      });
      const memberBody = member.node.childForFieldName("body");
      if (memberBody) callSites.push({ symbolPath: memberSymbolPath, typeName: t.name, bodyNode: memberBody });
    }
  }

  // Pass 3: base-list classification (hybrid: resolve locally when possible,
  // fall back to the IXxx naming convention only for unresolved references).
  for (const t of types) {
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    for (const base of t.bases) {
      const localKind = kindByName.get(base);
      let linkType: ReactorLinkType.INHERITS | ReactorLinkType.IMPLEMENTS;
      let resolved: boolean;

      if (t.kind === "struct") {
        // Structs may only implement interfaces - deterministic by language rule.
        linkType = ReactorLinkType.IMPLEMENTS;
        resolved = true;
      } else if (t.kind === "interface") {
        // Interface base lists are other interfaces it extends.
        linkType = ReactorLinkType.INHERITS;
        resolved = true;
      } else if (localKind === "interface") {
        linkType = ReactorLinkType.IMPLEMENTS;
        resolved = true;
      } else if (localKind === "class") {
        linkType = ReactorLinkType.INHERITS;
        resolved = true;
      } else {
        // Unresolved (external/cross-file) - fall back to the naming
        // convention, explicitly marked as an unresolved guess.
        linkType = looksLikeInterfaceName(base)
          ? ReactorLinkType.IMPLEMENTS
          : ReactorLinkType.INHERITS;
        resolved = false;
      }

      emitter.addInheritanceEdge(symbolPath, base, linkType);
      // Tag the edge's resolution provenance for downstream consumers.
      const lastEdge = (emitter as any).edges?.[(emitter as any).edges.length - 1];
      if (lastEdge?.data) lastEdge.data.resolved = resolved;
    }
  }

  // Pass 4: calls (incl. `new X()` construction edges).
  for (const site of callSites) {
    const refs = extractCalls(site.bodyNode);
    const seen = new Set<string>();
    for (const ref of refs) {
      let targetId: number | null = null;
      let title: string;
      if (ref.kind === "construction") {
        title = `new ${ref.name}`;
        targetId =
          emitter.resolveLocalPath(`${ref.name}.${ref.name}`) ?? emitter.resolveName(ref.name);
      } else if (!ref.receiver) {
        title = ref.name;
        targetId =
          emitter.resolveLocalPath(`${site.typeName}.${ref.name}`) ?? emitter.resolveName(ref.name);
      } else if (ref.receiver === "this" || ref.receiver === "base") {
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

export default analyseCSharpFile;
