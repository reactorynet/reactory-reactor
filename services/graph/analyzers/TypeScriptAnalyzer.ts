import * as ts from "typescript";
import fs from "fs";
import path from "path";
import Reactory from "@reactorynet/reactory-core";
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
  normalizeRelative,
  pathLogicalKey,
  symbolLogicalKey,
} from "../GraphIdentity";

export interface FileAnalysis {
  /** Symbol nodes discovered in the file (children of the file node). */
  symbols: ReactorNode[];
  /** External dependency nodes referenced by import statements (npm packages). */
  externals: ReactorNode[];
  /**
   * Edges originating in this file:
   *  - file -> file / npm  (imports, DEPENDENCY)
   *  - class -> base       (extends, INHERITS)
   *  - class -> interface  (implements, IMPLEMENTS)
   *  - symbol -> symbol    (calls, CALL)
   */
  edges: ReactorNodeLink[];
}

const CANDIDATE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Resolve a relative import specifier to a file inside the repo. */
const resolveRelativeImport = (
  fromFile: string,
  specifier: string
): string | null => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return candidate;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const ext of CANDIDATE_EXTENSIONS) {
      const candidate = path.join(base, `index${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        return candidate;
    }
  }
  return null;
};

const scriptKindFor = (filePath: string): ts.ScriptKind => {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".cjs") || filePath.endsWith(".mjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const isExported = (node: ts.Node): boolean => {
  // ts.getModifiers/canHaveModifiers only exist in TS >= 4.8; this codebase is
  // on 4.5.x, so read the legacy `modifiers` array directly.
  const modifiers: ReadonlyArray<ts.Modifier> = (node as any).modifiers || [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
};

/** Where an imported name resolves to. */
interface ImportBinding {
  relativeTarget?: string; // project-relative path of the resolved file
  external?: boolean;
  pkg?: string;
}

/**
 * Parse a TypeScript/JavaScript file with the compiler API and extract symbol
 * nodes plus edges: imports, class inheritance (extends/implements) and calls
 * (function/method invocations). Cross-file references are resolved through the
 * file's import bindings; node ids are deterministic (GraphIdentity), so edges
 * point at the correct node even before it is materialised.
 */
export const analyseTypeScriptFile = (
  fileNode: ReactorNode,
  context?: Reactory.Server.IReactoryContext
): FileAnalysis => {
  const data = fileNode.data || {};
  const filePath: string = data.path;
  const fqn: string = data.projectFqn;
  const relativePath: string = data.relativePath;
  const repoPath: string = data.repoPath;

  const result: FileAnalysis = { symbols: [], externals: [], edges: [] };
  if (!filePath || !fs.existsSync(filePath) || !fqn || !repoPath) return result;

  let sourceText: string;
  try {
    sourceText = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    context?.warn(`TypeScriptAnalyzer: cannot read ${filePath}: ${(err as Error).message}`);
    return result;
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(filePath)
    );
  } catch (err) {
    context?.warn(`TypeScriptAnalyzer: parse failed for ${filePath}: ${(err as Error).message}`);
    return result;
  }

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const externalIds = new Set<number>();
  const importBindings = new Map<string, ImportBinding>();
  /** Top-level symbol paths declared in this file (e.g. "Helper", "Helper.doThing"). */
  const localSymbols = new Set<string>();
  /** Edge de-duplication across the whole file. */
  const edgeIds = new Set<number>();

  const pushEdge = (edge: ReactorNodeLink) => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    result.edges.push(edge);
  };

  const externalIdFor = (specifier: string): { pkg: string; id: number } => {
    const pkg = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const id = nodeId(`npm:${pkg}`);
    if (!externalIds.has(id)) {
      externalIds.add(id);
      result.externals.push({
        id,
        index: id,
        name: pkg,
        key: `${nodeId(fqn)}|${id}`,
        type: ReactorNodeType.DEPENDENCY,
        description: `External dependency ${pkg}`,
        parentId: nodeId(fqn),
        providerId: fileNode.providerId,
        nameSpace: fileNode.nameSpace,
        version: fileNode.version,
        categories: [],
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: { kind: "external", package: pkg, projectFqn: fqn },
      });
    }
    return { pkg, id };
  };

  // ---- Pass 1: import bindings + import edges ------------------------------

  const recordImport = (specifier: string, names: string[], namedLocals: string[]) => {
    if (!specifier) return;
    if (specifier.startsWith(".")) {
      const resolved = resolveRelativeImport(filePath, specifier);
      if (!resolved) return;
      const targetRel = normalizeRelative(path.relative(repoPath, resolved));
      if (targetRel.startsWith("..")) return;
      const targetId = nodeId(pathLogicalKey(fqn, targetRel));
      pushEdge({
        id: linkId(fileNode.id, targetId, ReactorLinkType.DEPENDENCY),
        source: fileNode.id,
        target: targetId,
        types: [ReactorLinkType.DEPENDENCY, ReactorLinkType.DIRECT],
        title: specifier,
        description: `imports ${names.join(", ") || "*"} from ${specifier}`,
        projectId: data.projectId,
        data: { specifier, importedNames: names, resolved: targetRel },
      });
      namedLocals.forEach((n) => importBindings.set(n, { relativeTarget: targetRel }));
    } else {
      const { pkg, id } = externalIdFor(specifier);
      pushEdge({
        id: linkId(fileNode.id, id, ReactorLinkType.DEPENDENCY),
        source: fileNode.id,
        target: id,
        types: [ReactorLinkType.DEPENDENCY],
        title: pkg,
        description: `imports ${names.join(", ") || "*"} from ${pkg}`,
        projectId: data.projectId,
        data: { specifier, importedNames: names, external: true, package: pkg },
      });
      namedLocals.forEach((n) => importBindings.set(n, { external: true, pkg }));
    }
  };

  sourceFile.statements.forEach((stmt) => {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const names: string[] = [];
      const locals: string[] = [];
      const clause = stmt.importClause;
      if (clause) {
        if (clause.name) {
          names.push(clause.name.text);
          locals.push(clause.name.text);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            names.push(`* as ${clause.namedBindings.name.text}`);
            locals.push(clause.namedBindings.name.text);
          } else {
            clause.namedBindings.elements.forEach((e) => {
              names.push(e.name.text);
              locals.push(e.name.text);
            });
          }
        }
      }
      recordImport(stmt.moduleSpecifier.text, names, locals);
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      recordImport(stmt.moduleSpecifier.text, ["<re-export>"], []);
    }
  });

  // ---- Pass 2: symbol declarations ----------------------------------------

  interface Declared {
    node: ReactorNode;
    tsNode: ts.Node; // node whose body is walked for calls
    symbolPath: string;
    enclosingClass?: string;
  }
  const declared: Declared[] = [];
  const classDecls: ts.ClassDeclaration[] = [];

  const makeSymbolNode = (
    name: string,
    symbolKind: string,
    nodeType: ReactorNodeType,
    tsNode: ts.Node,
    parent: ReactorNode,
    qualifier?: string
  ): ReactorNode => {
    const symbolPath = qualifier ? `${qualifier}.${name}` : name;
    const id = nodeId(symbolLogicalKey(fqn, relativePath, symbolPath));
    localSymbols.add(symbolPath);
    return {
      id,
      index: id,
      name,
      key: appendAncestry(parent.key, id),
      type: nodeType,
      description: `${symbolKind} ${symbolPath}`,
      parentId: parent.id,
      providerId: fileNode.providerId,
      nameSpace: fileNode.nameSpace,
      version: fileNode.version,
      source: filePath,
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
        relativePath,
        repoPath,
        projectFqn: fqn,
        projectId: data.projectId,
        line: lineOf(tsNode),
        exported: isExported(tsNode),
      },
    };
  };

  sourceFile.statements.forEach((stmt) => {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      classDecls.push(stmt);
      const classNode = makeSymbolNode(
        stmt.name.text,
        "class",
        ReactorNodeType.PROCESS,
        stmt,
        fileNode
      );
      result.symbols.push(classNode);
      declared.push({ node: classNode, tsNode: stmt, symbolPath: stmt.name.text });
      stmt.members.forEach((member) => {
        if (
          (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
          member.name
        ) {
          const methodName = member.name.getText(sourceFile);
          const methodNode = makeSymbolNode(
            methodName,
            "method",
            ReactorNodeType.FUNCTION,
            member,
            classNode,
            stmt.name!.text
          );
          result.symbols.push(methodNode);
          declared.push({
            node: methodNode,
            tsNode: member,
            symbolPath: `${stmt.name!.text}.${methodName}`,
            enclosingClass: stmt.name!.text,
          });
        }
      });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const n = makeSymbolNode(stmt.name.text, "function", ReactorNodeType.FUNCTION, stmt, fileNode);
      result.symbols.push(n);
      declared.push({ node: n, tsNode: stmt, symbolPath: stmt.name.text });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      result.symbols.push(
        makeSymbolNode(stmt.name.text, "interface", ReactorNodeType.CHILD, stmt, fileNode)
      );
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      result.symbols.push(
        makeSymbolNode(stmt.name.text, "type", ReactorNodeType.CHILD, stmt, fileNode)
      );
    } else if (ts.isEnumDeclaration(stmt)) {
      result.symbols.push(
        makeSymbolNode(stmt.name.text, "enum", ReactorNodeType.CHILD, stmt, fileNode)
      );
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      stmt.declarationList.declarations.forEach((decl) => {
        if (ts.isIdentifier(decl.name)) {
          const isFn =
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer));
          const n = makeSymbolNode(
            decl.name.text,
            isFn ? "function" : "variable",
            isFn ? ReactorNodeType.FUNCTION : ReactorNodeType.CHILD,
            decl,
            fileNode
          );
          result.symbols.push(n);
          if (isFn) declared.push({ node: n, tsNode: decl, symbolPath: decl.name.text });
        }
      });
    }
  });

  // ---- Resolution of a referenced name to a target node id ----------------

  const resolveName = (name: string): number | null => {
    if (localSymbols.has(name))
      return nodeId(symbolLogicalKey(fqn, relativePath, name));
    const binding = importBindings.get(name);
    if (binding) {
      if (binding.relativeTarget)
        return nodeId(symbolLogicalKey(fqn, binding.relativeTarget, name));
      if (binding.external && binding.pkg) return nodeId(`npm:${binding.pkg}`);
    }
    return null;
  };

  const resolveLocalPath = (symbolPath: string): number | null =>
    localSymbols.has(symbolPath)
      ? nodeId(symbolLogicalKey(fqn, relativePath, symbolPath))
      : null;

  // ---- Pass 3: inheritance edges ------------------------------------------

  classDecls.forEach((cls) => {
    if (!cls.name || !cls.heritageClauses) return;
    const sourceId = nodeId(symbolLogicalKey(fqn, relativePath, cls.name.text));
    cls.heritageClauses.forEach((clause) => {
      const linkType =
        clause.token === ts.SyntaxKind.ExtendsKeyword
          ? ReactorLinkType.INHERITS
          : ReactorLinkType.IMPLEMENTS;
      clause.types.forEach((typeExpr) => {
        const exprName = ts.isIdentifier(typeExpr.expression)
          ? typeExpr.expression.text
          : typeExpr.expression.getText(sourceFile);
        const targetId = resolveName(exprName);
        if (targetId === null) return; // unresolved base type - skip to avoid noise
        pushEdge({
          id: linkId(sourceId, targetId, linkType),
          source: sourceId,
          target: targetId,
          types: [linkType],
          title: exprName,
          description: `${cls.name!.text} ${
            linkType === ReactorLinkType.INHERITS ? "extends" : "implements"
          } ${exprName}`,
          projectId: data.projectId,
          data: {
            relation: linkType === ReactorLinkType.INHERITS ? "extends" : "implements",
            baseName: exprName,
          },
        });
      });
    });
  });

  // ---- Pass 4: call edges --------------------------------------------------

  const collectCalls = (bodyNode: ts.Node, sourceId: number, enclosingClass?: string) => {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let targetId: number | null = null;
        let title = "";
        if (ts.isIdentifier(expr)) {
          title = expr.text;
          targetId = resolveName(expr.text);
        } else if (ts.isPropertyAccessExpression(expr)) {
          if (
            expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
            enclosingClass
          ) {
            title = `this.${expr.name.text}`;
            targetId = resolveLocalPath(`${enclosingClass}.${expr.name.text}`);
          } else if (ts.isIdentifier(expr.expression)) {
            // Obj.method(...) / ns.fn(...) - resolve the object identifier.
            title = `${expr.expression.text}.${expr.name.text}`;
            targetId = resolveName(expr.expression.text);
          }
        }
        if (targetId !== null && targetId !== sourceId) {
          pushEdge({
            id: linkId(sourceId, targetId, ReactorLinkType.CALL),
            source: sourceId,
            target: targetId,
            types: [ReactorLinkType.CALL],
            title,
            description: `calls ${title}`,
            projectId: data.projectId,
            data: { relation: "call", callee: title },
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(bodyNode, visit);
  };

  declared.forEach((d) => {
    // Only callables have meaningful bodies (functions, methods, arrow consts).
    collectCalls(d.tsNode, d.node.id, d.enclosingClass);
  });

  return result;
};

export default analyseTypeScriptFile;
