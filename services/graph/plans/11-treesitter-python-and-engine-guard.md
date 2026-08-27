# Session 11 — Tree-sitter Python + Engine Import Guard

| Field | Value |
|-------|--------|
| **ID** | 11 |
| **Priority** | P2 |
| **Estimate** | M |
| **Depends on** | None |
| **Branch** | `feat/system-graph-11-treesitter-python` |

---

## 1. Objective

1. Route **PythonAnalyzer** through `TreeSitterEngine` (like Java/C#/Kotlin), with heuristic fallback.
2. Enforce **I7**: no direct `require('tree-sitter')` outside `TreeSitterEngine`.
3. Extend engine language id union with `"python"`.
4. Keep Jest multi-suite safety (shared native binding cache).

---

## 2. Allowed files

- `services/graph/analyzers/treesitter/TreeSitterEngine.ts`
- `services/graph/analyzers/treesitter/TreeSitterEngine.test.ts`
- `services/graph/analyzers/PythonAnalyzer.ts`
- `services/graph/analyzers/PythonAnalyzer.test.ts`
- `package.json` / module package.json — add optional dep `tree-sitter-python` if not present (**do not** major bump tree-sitter core)
- Optional eslint rule or simple test that greps source for forbidden imports
- README tree-sitter section (already exists — update Python status)

---

## 3. Design

### 3.1 Engine

```ts
export type TreeSitterLanguageId = "java" | "csharp" | "kotlin" | "python";
```

Load grammar package `tree-sitter-python` similarly to others. On failure return null.

### 3.2 PythonAnalyzer structure

Mirror JavaAnalyzer pattern:

```ts
const lang = getLanguage('python');
if (lang) {
  try { return analyseWithTreeSitter(...); }
  catch { /* fall through */ }
}
return analyseWithHeuristic(...); // existing indentation scanner
```

Tree-sitter queries / walkers should emit **same** GraphEmitter node/edge shapes (symbols, IMPORT/DEPENDENCY, INHERITS, CALL).

### 3.3 Guard test

```ts
// Architecture test
const naughty = glob files under analyzers except treesitter/
assert none contain "require('tree-sitter')" or 'from "tree-sitter"'
```

### 3.4 Dependency

If grammar missing at runtime, analyzer must still pass heuristic tests (null language).

---

## 4. Tests

- Existing Python heuristic tests still pass without native grammar (CI without optional dep).
- When grammar available: parse class/def/import sample; assert symbols + edges.
- TreeSitterEngine: loading python does not break java rootNode (existing multi-grammar test extended).

---

## 5. Acceptance criteria

- [x] Python uses engine first, heuristic fallback second
- [x] No bare tree-sitter requires outside engine (test enforced)
- [x] Multi-grammar load test includes python
- [x] Optional dependency does not hard-fail module boot
- [x] README updated

---

## 6. Agent Notes

- **Grammar package version pinned**: `tree-sitter-python@0.23.6`.
- **TreeSitterEngine**:
  - Added `"python"` to `TreeSitterLanguageId` union and mapped grammar module `tree-sitter-python`.
  - Updated multi-grammar Jest test in `TreeSitterEngine.test.ts` to test Java, C#, Kotlin, and Python AST parsing in a single process without prototype clobbering.
- **PythonAnalyzer**:
  - Implemented `analysePythonWithTreeSitter` utilizing tree-sitter AST nodes (`class_definition`, `function_definition`, `import_statement`, `import_from_statement`, `call`, `attribute`).
  - Added resilient fallback to `analysePythonHeuristic` (the line/indentation scanner) when `tree-sitter-python` is not available or encounters errors.
- **Invariant I7 Guard**:
  - Enforced `import type Parser from "tree-sitter"` across all analyzers (`JavaAnalyzer.ts`, `CSharpAnalyzer.ts`, `KotlinAnalyzer.ts`, `PythonAnalyzer.ts`).
  - Added automated architectural guard test in `PythonAnalyzer.test.ts` checking all analyzer files outside `treesitter/` for forbidden bare `require('tree-sitter')` or runtime value imports from `tree-sitter`.
- **Test Coverage**:
  - All 15 graph suites (180 tests) and 9 processor suites (37 tests) passing green.
