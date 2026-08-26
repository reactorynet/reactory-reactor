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

- [ ] Python uses engine first, heuristic fallback second
- [ ] No bare tree-sitter requires outside engine (test enforced)
- [ ] Multi-grammar load test includes python
- [ ] Optional dependency does not hard-fail module boot
- [ ] README updated

---

## 6. Agent Notes

- Grammar package version pinned:
