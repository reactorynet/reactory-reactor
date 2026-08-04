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
 * Tree-sitter based Kotlin analyzer (Phase 0). Kotlin previously had NO
 * analyzer at all - `.kt` files (e.g. under a Gradle/Kotlin JVM project
 * detected by JavaProjectProcessor) were opaque leaf FILE nodes with zero
 * symbol/edge extraction. This closes that gap.
 *
 * Notable Kotlin-specific determinism win: unlike Java/C#, Kotlin's grammar
 * gives us a genuinely reliable, purely-syntactic way to distinguish "extends
 * a class" from "implements an interface" with NO naming convention and NO
 * local-resolution fallback needed - a `delegation_specifier` that wraps a
 * `constructor_invocation` (i.e. has value_arguments, e.g. `: Base()`) is
 * unambiguously a superclass call, since only classes have constructors to
 * invoke; a bare `user_type` with no invocation (e.g. `: Interface`) is
 * unambiguously interface conformance. This is a real language-grammar fact,
 * not a heuristic - it holds even for external/unresolved base types.
 *
 * Known open risk (flagged, not hidden): the tree-sitter-kotlin grammar
 * (mirroring Kotlin's own official ANTLR grammar) represents `class` and
 * `interface` declarations using the SAME node type (`class_declaration`),
 * distinguished only by which keyword token is present as a child. This
 * implementation detects that keyword via a defensive scan of all children
 * (named and anonymous). This detection strategy has NOT yet been verified
 * against a live jest run (blocked on shell/npm install access at authoring
 * time) - see KotlinAnalyzer.test.ts for the fixtures intended to prove it.
 *
 * Ceiling (same as Java/C#): no cross-file/cross-jar semantic resolution.
 * That is the planned opt-in Phase 2 "SDK route" (Kotlin embeddable compiler
 * PSI + BindingContext), surfaced via catalogProject.
 */

type TypeKind = "class" | "interface" | "enum" | "annotation" | "object";

const TYPE_DECL_TYPES = ["class_declaration", "object_declaration"];

/**
 * Kotlin's grammar uses one node type (`class_declaration`) for class,
 * interface, enum class and annotation class alike - the distinguishing
 * keyword is a child token. We scan ALL children (not just named) for the
 * first matching keyword type/text.
 */
const kotlinDeclKind = (node: Parser.SyntaxNode): TypeKind => {
  if (node.type === "object_declaration") return "object";
  for (const child of node.children) {
    if (child.type === "interface") return "interface";
    if (child.type === "enum") return "enum";
    if (child.type === "annotation") return "annotation";
  }
  return "class";
};

interface KotlinTypeInfo {
  node: Parser.SyntaxNode;
  name: string;
  kind: TypeKind;
  qualifier?: string;
  /** Base types this extends (constructor_invocation delegation - real class inheritance). */
  inherits: string[];
  /** Interfaces this implements (bare user_type delegation - no invocation). */
  implements: string[];
  hasPrimaryConstructor: boolean;
}

const delegationSpecifiers = (
  typeNode: Parser.SyntaxNode
): { inherits: string[]; implements: string[] } => {
  const inherits: string[] = [];
  const implementsList: string[] = [];
  const delegations = typeNode.namedChildren.find((c) => c.type === "delegation_specifiers");
  if (!delegations) return { inherits, implements: implementsList };
  for (const spec of delegations.namedChildren) {
    if (spec.type !== "delegation_specifier") continue;
    const invocation = spec.namedChildren.find((c) => c.type === "constructor_invocation");
    if (invocation) {
      const userType = invocation.namedChildren.find((c) => c.type === "user_type");
      if (userType) inherits.push(cleanTypeName(userType.text));
    } else {
      const userType = spec.namedChildren.find((c) => c.type === "user_type");
      if (userType) implementsList.push(cleanTypeName(userType.text));
    }
  }
  return { inherits, implements: implementsList };
};

const collectTypes = (root: Parser.SyntaxNode): KotlinTypeInfo[] => {
  const results: KotlinTypeInfo[] = [];

  const visit = (node: Parser.SyntaxNode, qualifier?: string) => {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? nameNode.text : "<anonymous>";
    const kind = kotlinDeclKind(node);
    const { inherits, implements: implementsList } = delegationSpecifiers(node);
    const hasPrimaryConstructor = node.namedChildren.some((c) => c.type === "primary_constructor");

    results.push({ node, name, kind, qualifier, inherits, implements: implementsList, hasPrimaryConstructor });

    const body = node.namedChildren.find((c) => c.type === "class_body");
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

const directFunctionsAndConstructors = (
  bodyNode: Parser.SyntaxNode
): { kind: "function" | "constructor"; node: Parser.SyntaxNode; name: string }[] => {
  const out: { kind: "function" | "constructor"; node: Parser.SyntaxNode; name: string }[] = [];
  for (const child of bodyNode.namedChildren) {
    if (child.type === "function_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) out.push({ kind: "function", node: child, name: nameNode.text });
    } else if (child.type === "secondary_constructor") {
      out.push({ kind: "constructor", node: child, name: "constructor" });
    }
  }
  return out;
};

interface KotlinCallRef {
  receiver?: string; // "this" | identifier | undefined (bare call)
  name: string;
}

const extractCalls = (node: Parser.SyntaxNode): KotlinCallRef[] => {
  const refs: KotlinCallRef[] = [];
  const calls = collectDescendants(node, ["call_expression"], TYPE_DECL_TYPES);
  for (const call of calls) {
    const callee = call.namedChildren[0];
    if (!callee) continue;
    if (callee.type === "simple_identifier" || callee.type === "identifier") {
      refs.push({ name: callee.text });
    } else if (callee.type === "navigation_expression") {
      const receiverNode = callee.namedChildren[0];
      const memberNode = callee.namedChildren[callee.namedChildren.length - 1];
      if (!memberNode) continue;
      if (!receiverNode || receiverNode.type === "this_expression") {
        refs.push({ receiver: "this", name: memberNode.text });
      } else if (receiverNode.type === "super_expression") {
        refs.push({ receiver: "super", name: memberNode.text });
      } else if (
        receiverNode.type === "simple_identifier" ||
        receiverNode.type === "identifier"
      ) {
        refs.push({ receiver: receiverNode.text, name: memberNode.text });
      }
      // Other receiver shapes intentionally produce no edge.
    }
  }
  return refs;
};

export const analyseKotlinFile = async (
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
    context?.warn(`KotlinAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  let root: Parser.SyntaxNode;
  try {
    const parsed = await parseSource("kotlin", raw);
    root = parsed.rootNode;
    if (parsed.hasError) {
      context?.warn(`KotlinAnalyzer: parse errors in ${filePath}; results may be partial`);
    }
  } catch (err) {
    context?.warn(`KotlinAnalyzer: tree-sitter parse failed for ${filePath}: ${(err as Error).message}`);
    return emitter.finish();
  }

  // ---- imports ----
  for (const imp of root.namedChildren.filter((c) => c.type === "import_header")) {
    const text = imp.text.trim().replace(/^import\s+/, "");
    const wildcard = text.endsWith(".*");
    const full = wildcard ? text.slice(0, -2) : text.split(" as ")[0].trim();
    const aliasMatch = text.match(/\sas\s+(\w+)$/);
    if (!full) continue;
    const externalId = emitter.addExternal(full, `kotlin:${full}`);
    emitter.addImportExternalEdge(externalId, full, full, [full]);
    if (aliasMatch) {
      emitter.bindExternal(aliasMatch[1], externalId);
    } else if (!wildcard) {
      emitter.bindExternal(full.split(".").pop()!, externalId);
    }
  }

  // ---- type declarations (incl. nested/sealed-class-members) ----
  const types = collectTypes(root);
  const typeNodeByQualifiedName = new Map<string, ReactorNode>();

  // Pass 1: register type symbols.
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

    // Primary constructor -> its own "constructor" symbol (parity with Java/C#).
    if (t.hasPrimaryConstructor) {
      emitter.addSymbol("constructor", "constructor", ReactorNodeType.FUNCTION, lineOf(t.node), {
        qualifier: symbolPath,
        parent: symbolNode,
      });
    }
  }

  // Pass 2: functions + secondary constructors.
  const callSites: { symbolPath: string; typeName: string; bodyNode: Parser.SyntaxNode }[] = [];
  for (const t of types) {
    const body = t.node.namedChildren.find((c) => c.type === "class_body");
    if (!body) continue;
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    const parentSymbol = typeNodeByQualifiedName.get(symbolPath);
    for (const member of directFunctionsAndConstructors(body)) {
      const memberSymbolPath = `${symbolPath}.${member.name}`;
      emitter.addSymbol(
        member.name,
        member.kind,
        ReactorNodeType.FUNCTION,
        lineOf(member.node),
        { qualifier: symbolPath, parent: parentSymbol }
      );
      const memberBody =
        member.node.namedChildren.find((c) => c.type === "function_body") ||
        member.node.namedChildren.find((c) => c.type === "block");
      if (memberBody) callSites.push({ symbolPath: memberSymbolPath, typeName: t.name, bodyNode: memberBody });
    }
  }

  // Pass 3: inheritance/implementation - a real syntactic distinction (see
  // module doc comment), not a heuristic.
  for (const t of types) {
    const symbolPath = t.qualifier ? `${t.qualifier}.${t.name}` : t.name;
    t.inherits.forEach((base) => emitter.addInheritanceEdge(symbolPath, base, ReactorLinkType.INHERITS));
    t.implements.forEach((base) => emitter.addInheritanceEdge(symbolPath, base, ReactorLinkType.IMPLEMENTS));
  }

  // Pass 4: calls. Kotlin has no `new` keyword - `Foo()` is syntactically
  // identical whether Foo is a function or a class constructor, so we
  // disambiguate using our own locally-known type names: if the bare callee
  // name matches a locally declared type, target its constructor/type symbol.
  const localTypeNames = new Set(types.map((t) => t.name));
  for (const site of callSites) {
    const refs = extractCalls(site.bodyNode);
    const seen = new Set<string>();
    for (const ref of refs) {
      let targetId: number | null = null;
      let title: string;
      if (!ref.receiver) {
        title = ref.name;
        if (localTypeNames.has(ref.name)) {
          targetId =
            emitter.resolveLocalPath(`${ref.name}.constructor`) ?? emitter.resolveName(ref.name);
        } else {
          targetId =
            emitter.resolveLocalPath(`${site.typeName}.${ref.name}`) ?? emitter.resolveName(ref.name);
        }
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

export default analyseKotlinFile;
