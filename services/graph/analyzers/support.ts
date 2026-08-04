import {
  ReactorNode,
  ReactorNodeType,
  ReactorNodeLink,
  ReactorLinkType,
} from "../../../types/model.types";
import {
  appendAncestry,
  linkId,
  nodeId,
  pathLogicalKey,
  symbolLogicalKey,
} from "../GraphIdentity";

/** Standard analyzer output shape (shared with the TypeScript analyzer). */
export interface FileAnalysis {
  symbols: ReactorNode[];
  externals: ReactorNode[];
  edges: ReactorNodeLink[];
}

interface ImportBinding {
  /** project-relative path of a resolved in-repo file */
  relativeTarget?: string;
  /** id of an external dependency node */
  externalId?: number;
}

/**
 * GraphEmitter centralises deterministic node/edge construction for the
 * heuristic (non-TypeScript) language analyzers. It tracks the file's local
 * symbols and import bindings so references (inheritance, calls) can be
 * resolved to the correct target node id.
 *
 * Node/edge ids come from GraphIdentity, so the output is identical shape and
 * id-space to the TypeScript analyzer's.
 */
export class GraphEmitter {
  readonly symbols: ReactorNode[] = [];
  readonly externals: ReactorNode[] = [];
  readonly edges: ReactorNodeLink[] = [];

  private readonly fqn: string;
  private readonly relativePath: string;
  private readonly filePath: string;
  private readonly localSymbols = new Set<string>();
  private readonly bindings = new Map<string, ImportBinding>();
  private readonly edgeIds = new Set<number>();
  private readonly externalIds = new Set<number>();

  constructor(private fileNode: ReactorNode) {
    const data = fileNode.data || {};
    this.fqn = data.projectFqn;
    this.relativePath = data.relativePath;
    this.filePath = data.path;
  }

  private pushEdge(edge: ReactorNodeLink) {
    if (this.edgeIds.has(edge.id)) return;
    this.edgeIds.add(edge.id);
    this.edges.push(edge);
  }

  /** Register a symbol node (class/function/method/interface/...). */
  addSymbol(
    name: string,
    symbolKind: string,
    nodeType: ReactorNodeType,
    line: number,
    opts: { qualifier?: string; exported?: boolean; parent?: ReactorNode } = {}
  ): ReactorNode {
    const symbolPath = opts.qualifier ? `${opts.qualifier}.${name}` : name;
    const id = nodeId(symbolLogicalKey(this.fqn, this.relativePath, symbolPath));
    this.localSymbols.add(symbolPath);
    const parent = opts.parent || this.fileNode;
    const node: ReactorNode = {
      id,
      index: id,
      name,
      key: appendAncestry(parent.key, id),
      type: nodeType,
      description: `${symbolKind} ${symbolPath}`,
      parentId: parent.id,
      providerId: this.fileNode.providerId,
      nameSpace: this.fileNode.nameSpace,
      version: this.fileNode.version,
      source: this.filePath,
      categories: [],
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: {
        kind: "symbol",
        symbolKind,
        symbolPath,
        relativePath: this.relativePath,
        repoPath: (this.fileNode.data || {}).repoPath,
        projectFqn: this.fqn,
        projectId: (this.fileNode.data || {}).projectId,
        line,
        exported: opts.exported !== false,
      },
    };
    this.symbols.push(node);
    return node;
  }

  /** Register (once) an external dependency node and return its id. */
  addExternal(displayName: string, key: string): number {
    const id = nodeId(key);
    if (!this.externalIds.has(id)) {
      this.externalIds.add(id);
      this.externals.push({
        id,
        index: id,
        name: displayName,
        key: `${nodeId(this.fqn)}|${id}`,
        type: ReactorNodeType.DEPENDENCY,
        description: `External dependency ${displayName}`,
        parentId: nodeId(this.fqn),
        providerId: this.fileNode.providerId,
        nameSpace: this.fileNode.nameSpace,
        version: this.fileNode.version,
        categories: [],
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: { kind: "external", package: displayName, key, projectFqn: this.fqn },
      });
    }
    return id;
  }

  bindFile(localName: string, relativeTarget: string) {
    this.bindings.set(localName, { relativeTarget });
  }

  bindExternal(localName: string, externalId: number) {
    this.bindings.set(localName, { externalId });
  }

  /** file -> in-repo file DEPENDENCY edge. */
  addImportFileEdge(targetRel: string, specifier: string, names: string[]) {
    const fileTargetId = nodeId(pathLogicalKey(this.fqn, targetRel));
    this.pushEdge({
      id: linkId(this.fileNode.id, fileTargetId, ReactorLinkType.DEPENDENCY),
      source: this.fileNode.id,
      target: fileTargetId,
      types: [ReactorLinkType.DEPENDENCY, ReactorLinkType.DIRECT],
      title: specifier,
      description: `imports ${names.join(", ") || "*"} from ${specifier}`,
      projectId: (this.fileNode.data || {}).projectId,
      data: { specifier, importedNames: names, resolved: targetRel },
    });
  }

  /** file -> external dependency DEPENDENCY edge. */
  addImportExternalEdge(
    externalId: number,
    displayName: string,
    specifier: string,
    names: string[]
  ) {
    this.pushEdge({
      id: linkId(this.fileNode.id, externalId, ReactorLinkType.DEPENDENCY),
      source: this.fileNode.id,
      target: externalId,
      types: [ReactorLinkType.DEPENDENCY],
      title: displayName,
      description: `imports ${names.join(", ") || "*"} from ${specifier}`,
      projectId: (this.fileNode.data || {}).projectId,
      data: { specifier, importedNames: names, external: true, package: displayName },
    });
  }

  /** class -> base type edge (INHERITS / IMPLEMENTS). */
  addInheritanceEdge(
    sourceSymbolPath: string,
    baseName: string,
    linkType: ReactorLinkType.INHERITS | ReactorLinkType.IMPLEMENTS,
    extraData?: Record<string, any>
  ) {
    const sourceId = nodeId(symbolLogicalKey(this.fqn, this.relativePath, sourceSymbolPath));
    let targetId = this.resolveName(baseName);
    if (targetId === null) {
      targetId = this.addExternal(baseName, `type:${baseName}`);
    }
    this.pushEdge({
      id: linkId(sourceId, targetId, linkType),
      source: sourceId,
      target: targetId,
      types: [linkType],
      title: baseName,
      description: `${sourceSymbolPath} ${
        linkType === ReactorLinkType.INHERITS ? "extends" : "implements"
      } ${baseName}`,
      projectId: (this.fileNode.data || {}).projectId,
      data: {
        relation: linkType === ReactorLinkType.INHERITS ? "extends" : "implements",
        baseName,
        ...(extraData || {}),
      },
    });
  }

  /** symbol -> symbol CALL edge. */
  addCallEdge(sourceSymbolPath: string, title: string, targetId: number | null) {
    if (targetId === null) return;
    const sourceId = nodeId(symbolLogicalKey(this.fqn, this.relativePath, sourceSymbolPath));
    if (sourceId === targetId) return;
    this.pushEdge({
      id: linkId(sourceId, targetId, ReactorLinkType.CALL),
      source: sourceId,
      target: targetId,
      types: [ReactorLinkType.CALL],
      title,
      description: `calls ${title}`,
      projectId: (this.fileNode.data || {}).projectId,
      data: { relation: "call", callee: title },
    });
  }

  /** Resolve a referenced name to a node id (local symbol or import binding). */
  resolveName(name: string): number | null {
    if (this.localSymbols.has(name))
      return nodeId(symbolLogicalKey(this.fqn, this.relativePath, name));
    for (const sym of this.localSymbols) {
      if (sym === name || sym.endsWith("." + name))
        return nodeId(symbolLogicalKey(this.fqn, this.relativePath, sym));
    }
    const binding = this.bindings.get(name);
    if (binding) {
      if (binding.relativeTarget)
        return nodeId(symbolLogicalKey(this.fqn, binding.relativeTarget, name));
      if (binding.externalId !== undefined) return binding.externalId;
    }
    return null;
  }

  /** Resolve a fully-qualified local symbol path (e.g. "Class.method"). */
  resolveLocalPath(symbolPath: string): number | null {
    return this.localSymbols.has(symbolPath)
      ? nodeId(symbolLogicalKey(this.fqn, this.relativePath, symbolPath))
      : null;
  }

  hasLocal(symbolPath: string): boolean {
    return this.localSymbols.has(symbolPath);
  }

  finish(): FileAnalysis {
    return { symbols: this.symbols, externals: this.externals, edges: this.edges };
  }
}

/**
 * Extract candidate call targets from a body of source text. Returns tokens of
 * three shapes: bare `name(`, `self`/`this` member `x.m(`, and `Obj.m(`.
 * Keyword-like identifiers are filtered by the caller via the resolver
 * (unresolved names produce no edge).
 */
export interface CallToken {
  kind: "bare" | "member";
  receiver?: string; // for member calls: the object identifier or self/this
  name: string;
}

const CALL_RE = /(?:([A-Za-z_][\w]*)\s*\.\s*)?([A-Za-z_][\w]*)\s*\(/g;

export const extractCallTokens = (body: string): CallToken[] => {
  const tokens: CallToken[] = [];
  let m: RegExpExecArray | null;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(body)) !== null) {
    const receiver = m[1];
    const name = m[2];
    if (receiver) tokens.push({ kind: "member", receiver, name });
    else tokens.push({ kind: "bare", name });
  }
  return tokens;
};

/**
 * Blank out comments and string/char literal *contents* in C-family source
 * while preserving length and newlines, so brace/paren counting and
 * declaration regexes are not fooled by braces inside strings or comments.
 */
export const sanitizeCLike = (src: string): string => {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "block" | "line" | "dq" | "sq";
  let state: State = "code";
  const keep = (c: string) => (c === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { out += "  "; i += 2; state = "line"; continue; }
      if (c === "/" && c2 === "*") { out += "  "; i += 2; state = "block"; continue; }
      if (c === '"') { out += " "; i++; state = "dq"; continue; }
      if (c === "'") { out += " "; i++; state = "sq"; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { out += "\n"; i++; state = "code"; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { out += "  "; i += 2; state = "code"; continue; }
      out += keep(c); i++; continue;
    }
    if (state === "dq") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === '"') { out += " "; i++; state = "code"; continue; }
      out += keep(c); i++; continue;
    }
    // sq
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "'") { out += " "; i++; state = "code"; continue; }
    out += keep(c); i++; continue;
  }
  return out;
};

/** Given the index of an opening `{`, return the index of the matching `}`. */
export const matchBrace = (text: string, openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
};

/** 1-based line number of a character index. */
export const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
};

/** Control-flow keywords that must never be treated as method/type names. */
const BRACE_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "else", "do",
  "try", "throw", "synchronized", "super", "this", "instanceof", "assert",
  "case", "break", "continue", "default", "using", "lock", "foreach", "await",
  "yield", "get", "set",
]);

export interface TopLevelMember {
  signature: string; // text before the block/`;`
  hasBody: boolean;
  declStart: number; // index in body where the member starts
  bodyOpen?: number; // index of `{` (hasBody only)
  bodyEnd?: number; // index of matching `}` (hasBody only)
}

/**
 * Split a class/interface body into its direct members at brace depth 0. Bodies
 * of nested members are skipped, so calls inside one method are not mistaken for
 * declarations of a sibling.
 */
export const topLevelMembers = (body: string): TopLevelMember[] => {
  const members: TopLevelMember[] = [];
  let i = 0;
  let start = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{") {
      const end = matchBrace(body, i);
      members.push({ signature: body.slice(start, i), hasBody: true, declStart: start, bodyOpen: i, bodyEnd: end });
      i = end + 1;
      start = i;
      continue;
    }
    if (c === ";") {
      members.push({ signature: body.slice(start, i), hasBody: false, declStart: start });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return members;
};

/**
 * If a member signature looks like a method declaration, return the method
 * name; otherwise null. Excludes fields (contain `=`), control statements and
 * keyword-named constructs.
 */
export const matchMethodName = (signature: string): string | null => {
  const s = signature.trim();
  if (!s || s.includes("=")) return null;
  // nested type declarations are not methods
  if (/\b(class|interface|enum|struct|namespace)\b/.test(s)) return null;
  const m = s.match(/\b([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws[\w.,\s]+)?$/);
  if (!m) return null;
  if (BRACE_KEYWORDS.has(m[1])) return null;
  return m[1];
};

/** Strip generic args and namespace qualifiers from a base-type reference. */
export const cleanTypeName = (base: string): string =>
  base
    .replace(/<[^>]*>/g, "")
    .trim()
    .split(".")
    .pop()!
    .trim();

export interface BraceType {
  name: string;
  kind: "class" | "interface" | "enum" | "struct";
  inherits: string[]; // extends / base class -> INHERITS
  implements: string[]; // implements / interfaces -> IMPLEMENTS
  bodyOpen: number; // index of `{` in the sanitized source
  bodyEnd: number; // index of matching `}`
  line: number;
}

/**
 * Shared emission for C-family (brace) languages: registers type + method
 * symbols, inheritance edges and intra/inter-type call edges. Import bindings
 * must already be registered on the emitter.
 */
export const emitBraceTypes = (
  emitter: GraphEmitter,
  sanitized: string,
  types: BraceType[]
): void => {
  const typeNodes = new Map<string, ReactorNode>();

  // Pass 1: type symbols (so names resolve for inheritance + calls).
  for (const t of types) {
    const nodeType =
      t.kind === "interface" || t.kind === "enum"
        ? ReactorNodeType.CHILD
        : ReactorNodeType.PROCESS;
    typeNodes.set(t.name, emitter.addSymbol(t.name, t.kind, nodeType, t.line));
  }

  // Pass 2: methods.
  const methods: { symbolPath: string; className: string; callBody: string }[] = [];
  for (const t of types) {
    const body = sanitized.slice(t.bodyOpen + 1, t.bodyEnd);
    for (const member of topLevelMembers(body)) {
      const name = matchMethodName(member.signature);
      if (!name) continue;
      const line = lineAt(sanitized, t.bodyOpen + 1 + member.declStart);
      emitter.addSymbol(name, "method", ReactorNodeType.FUNCTION, line, {
        qualifier: t.name,
        parent: typeNodes.get(t.name),
      });
      if (member.hasBody && member.bodyOpen !== undefined && member.bodyEnd !== undefined) {
        methods.push({
          symbolPath: `${t.name}.${name}`,
          className: t.name,
          callBody: body.slice(member.bodyOpen + 1, member.bodyEnd),
        });
      }
    }
  }

  // Pass 3: inheritance.
  for (const t of types) {
    t.inherits.forEach((b) =>
      emitter.addInheritanceEdge(t.name, cleanTypeName(b), ReactorLinkType.INHERITS)
    );
    t.implements.forEach((b) =>
      emitter.addInheritanceEdge(t.name, cleanTypeName(b), ReactorLinkType.IMPLEMENTS)
    );
  }

  // Pass 4: calls.
  for (const mth of methods) {
    const tokens = extractCallTokens(mth.callBody);
    const seen = new Set<string>();
    for (const tok of tokens) {
      let targetId: number | null = null;
      let title = tok.name;
      if (tok.kind === "member") {
        if (tok.receiver === "this" || tok.receiver === "base" || tok.receiver === "super") {
          title = `${tok.receiver}.${tok.name}`;
          targetId = emitter.resolveLocalPath(`${mth.className}.${tok.name}`);
        } else if (tok.receiver) {
          title = `${tok.receiver}.${tok.name}`;
          targetId = emitter.resolveName(tok.receiver);
        }
      } else {
        // bare call: sibling method first, then a resolvable name.
        targetId =
          emitter.resolveLocalPath(`${mth.className}.${tok.name}`) ??
          emitter.resolveName(tok.name);
      }
      if (targetId === null) continue;
      const key = `${title}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      emitter.addCallEdge(mth.symbolPath, title, targetId);
    }
  }
};
