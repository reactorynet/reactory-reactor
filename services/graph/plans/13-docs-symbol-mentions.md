# Session 13 — Documentation Symbol Mention Edges

| Field | Value |
|-------|--------|
| **ID** | 13 |
| **Priority** | P3 |
| **Estimate** | M |
| **Depends on** | **01**, **03** |
| **Branch** | `feat/system-graph-13-docs-mentions` |

---

## 1. Objective

Documents only link to code when markdown contains an explicit path link. Prose like “see `SystemGraphManager`” produces nothing.

**After document parse (or in a second pass), match high-confidence symbol name mentions against the project’s exported/symbol index and emit `MENTIONS` or `DOCUMENTS` edges with a confidence field.**

---

## 2. Out of scope

- LLM-based entity linking
- Cross-project symbol search
- Changing markdown parser fence rules

---

## 3. Allowed files

- `services/graph/documents/DocumentGraphEmitter.ts`
- `services/graph/documents/DocumentTypes.ts` (confidence on edge data)
- `services/graph/documents/DocumentGraph.test.ts`
- Optional: `BaseProjectProcessor.process` second pass after all symbols known
- README §4 / §9

---

## 4. Design (precision over recall)

### 4.1 Symbol index

During process, after all files analysed (or lazy load from DB):

```ts
Map<string, number[]>  // symbolName → nodeIds (may be ambiguous)
```

Only include:

- `exported === true` OR top-level functions/classes
- name length ≥ 3
- Exclude common words: `data`, `test`, `config`, `index`, `get`, `set`, `type`, `props`, `state`, `value`, `item`, `list`, `name`, `file`, `path` (maintain denylist)

### 4.2 Mention extraction

From document outline plain text + fenced code **language identifiers only** (not code body — too noisy).

Also match inline code spans `` `SystemGraphManager` `` from markdown parser if already extracted as links of kind path — if not, scan section text for `` `([A-Z][A-Za-z0-9_]{2,})` `` and `\b([A-Z][A-Za-z0-9_]{2,})\b` camel/pascal only.

### 4.3 Disambiguation

- If exactly one nodeId for name → edge confidence 0.9
- If multiple → prefer same-folder / same path prefix as doc; else **skip** (no edge)
- Never invent nodes

### 4.4 Edge

```ts
{
  id: linkId(sectionOrDocId, symbolId, MENTIONS),
  types: [MENTIONS],
  data: { confidence, match: 'inline-code' | 'prose-pascal' }
}
```

### 4.5 Performance

O(symbols + doc text). For large projects build index once per process.

### 4.6 Feature flag

`process(project, { linkDocMentions: true })` default **true** after tests; allow disable.

---

## 5. Tests

- Doc with `` `HelloService` `` and unique class HelloService → MENTIONS edge.
- Ambiguous two HelloService → no edge.
- Denylisted `Config` → no edge.
- Explicit path link still works (no regression).

---

## 6. Acceptance criteria

- [x] High-confidence unique mentions create MENTIONS edges
- [x] Ambiguous names create zero edges
- [x] I4 held (target exists)
- [x] DocumentGraph tests green
- [x] Toggle to disable

---

## 7. Agent Notes

- **Implementation Details**:
  - Added `SymbolIndexEntry`, `SymbolIndex`, `DocMentionData`, `DocMentionMatchKind`, and `DocumentGraphOptions` to `DocumentTypes.ts`.
  - Implemented `buildSymbolIndex`, `normalizeSymbolIndex`, `disambiguateSymbol`, `linkDocSymbolMentions`, and `SYMBOL_DENYLIST` in `DocumentGraphEmitter.ts`.
  - `buildSymbolIndex` extracts exported or top-level symbols (classes, functions, interfaces, types, enums), excluding stopwords (`data`, `test`, `config`, `index`, `get`, `set`, `type`, `props`, `state`, `value`, `item`, `list`, `name`, `file`, `path`) and short identifiers (< 3 characters).
  - Scans document text (excluding fenced code block bodies) for inline code spans (`` `SymbolName` ``) and PascalCase/CamelCase prose words, emitting `MENTIONS` edges with `{ confidence: 0.9, match: 'inline-code' | 'prose-pascal' }` parented to the originating section.
  - Disambiguation prioritizes same-folder candidates or longest common path prefix; unresolved ties emit zero edges to prevent false links (Invariant I4).
  - Added second-pass document mention linking to `BaseProjectProcessor.process` so batch indexing connects documentation with code symbols across the whole project.
  - Added feature flag `linkDocMentions` (defaulting to true) to allow disabling mention edge extraction.
  - Added full test coverage in `DocumentGraph.test.ts` and `GraphBuilding.test.ts`. All tests green.
