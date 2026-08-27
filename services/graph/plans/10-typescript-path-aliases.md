# Session 10 — TypeScript Path Alias & baseUrl Resolution

| Field | Value |
|-------|--------|
| **ID** | 10 |
| **Priority** | P2 |
| **Estimate** | M |
| **Depends on** | 01 helpful not required |
| **Branch** | `feat/system-graph-10-ts-paths` |

---

## 1. Objective

`TypeScriptAnalyzer.resolveRelativeImport` only handles relative `./` and `../` specifiers. Imports like `@reactory/server-core/...` or `src/foo` via `tsconfig` paths become external/npm nodes incorrectly or drop edges.

**Resolve non-relative imports using the nearest `tsconfig.json` `compilerOptions.paths` + `baseUrl` when the target file exists in-repo.**

---

## 2. Allowed files

- `services/graph/analyzers/TypeScriptAnalyzer.ts`
- `services/graph/analyzers/TypeScriptAnalyzer.test.ts`
- Optional small helper `services/graph/analyzers/tsconfigPaths.ts`
- README analyzer section

Do not change processor selection.

---

## 3. Design

### 3.1 Find tsconfig

From `filePath`, walk parents until `tsconfig.json` or `tsconfig.build.json` under `repoPath`. Cache parsed config per repoPath in a module-level WeakMap/Map.

### 3.2 Parse paths

Use `ts.readConfigFile` + `ts.parseJsonConfigFileContent` if available in the project's TypeScript version (4.5.x — verify APIs). Fallback: JSON.parse and manual paths.

### 3.3 Match

For specifier `S`:

1. If `S.startsWith('.')` → existing relative resolver.
2. Else try `paths` patterns (`@app/*` → `src/*`):
   - Longest prefix match
   - Map remainder, try extensions via existing `CANDIDATE_EXTENSIONS`
3. Else try `baseUrl + S`
4. If resolved file under repoPath → DEPENDENCY edge to that file node id
5. Else → external package node (first path segment) as today for bare imports

### 3.4 Do not

- Full `ts.createProgram` typechecker (too heavy for this session)
- Resolve node_modules internals beyond package root external node

---

## 4. Tests

Fixture temp project:

```json
// tsconfig.json
{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }
```

```ts
// src/main.ts
import { x } from '@lib/util';
// src/lib/util.ts
export const x = 1;
```

Expect DEPENDENCY edge from main file → util file, **not** external `@lib`.

Also: unmatched `@scope/pkg` still external.

---

## 5. Acceptance criteria

- [x] Path alias in-repo resolves to file id via GraphIdentity
- [x] Relative imports unchanged
- [x] Missing alias target does not throw; no dangling edge (I4)
- [x] Config cached per repo (spy read count ≤ 1 per process batch ideally)
- [x] Tests green

---

## 6. Agent Notes

- **Implementation**:
  - Implemented `services/graph/analyzers/tsconfigPaths.ts` supporting `tsconfig.json` / `tsconfig.build.json` discovery walking up directories up to `repoPath`, memoizing directory-to-config lookups and parsed `TsconfigInfo` in Maps.
  - Implemented wildcard and exact path pattern matching (longest prefix match descending) against `compilerOptions.paths` and `compilerOptions.baseUrl`, resolving against candidate extensions (`.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`) and directory `index` files.
  - Integrated `resolveTsconfigImport` into Pass 1 of `TypeScriptAnalyzer.ts` before external fallback, binding local names with `relativeTarget` to seamlessly resolve cross-file CALL and INHERITS/IMPLEMENTS edges in later passes.
  - Unmatched imports or missing alias targets gracefully fall back to external dependency nodes without throwing or creating dangling edges (invariant I4 preserved).
- **Tests**:
  - Added comprehensive test suite in `TypeScriptAnalyzer.test.ts` covering wildcard aliases, exact aliases, nested wildcards, baseUrl-relative imports, cross-file inherits/calls via aliases, external package fallbacks, missing alias targets, caching spy checks (read count ≤ 1), and boundary checking.
  - All 15 graph suites (177 tests) and 9 processor suites (37 tests) passing green.
