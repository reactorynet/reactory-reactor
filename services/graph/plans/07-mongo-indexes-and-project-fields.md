# Session 07 — Mongo Indexes & First-Class Project Fields

| Field | Value |
|-------|--------|
| **ID** | 07 |
| **Priority** | P1 |
| **Estimate** | S |
| **Depends on** | **02** (fields exist) |
| **Branch** | `feat/system-graph-07-indexes` |

---

## 1. Objective

Declare compound indexes that match hot query patterns for nodes and links. Ensure `projectId` / `projectFqn` / `runId` / `type` are indexed appropriately.

---

## 2. Allowed files

- `models/ReactorGraphNode.ts`
- `models/ReactorNodeLink.ts`
- `models/ReactorProject.ts` (graphRootId index if 04 added field)
- Optional: startup ensureIndexes note in service `onStartup` — **avoid** heavy sync ensure in hot path; schema index defs are enough for mongoose.

---

## 3. Required indexes

### reactor_nodes

```ts
// existing: id unique, key, providerId, parentId
ReactorNodeSchema.index({ projectId: 1, runId: 1 });
ReactorNodeSchema.index({ projectId: 1, parentId: 1 });
ReactorNodeSchema.index({ projectId: 1, type: 1 });
ReactorNodeSchema.index({ type: 1, name: 1 });
ReactorNodeSchema.index({ projectFqn: 1, type: 1 });
// optional text:
// ReactorNodeSchema.index({ name: 'text', description: 'text' });
```

### reactor_node_links

```ts
// existing: id unique, source, target, projectId, source+target
ReactorNodeLinkSchema.index({ projectId: 1, runId: 1 });
ReactorNodeLinkSchema.index({ source: 1, types: 1 });
ReactorNodeLinkSchema.index({ target: 1, types: 1 });
ReactorNodeLinkSchema.index({ projectId: 1, source: 1 });
ReactorNodeLinkSchema.index({ projectId: 1, target: 1 });
```

### reactor_projects

```ts
ReactorProjectSchema.index({ graphRootId: 1 }, { unique: true, sparse: true });
```

---

## 4. Verification

- Document in README how to build indexes in prod:  
  `db.reactor_nodes.createIndex(...)` or mongoose `syncIndexes` in maintenance window.
- Add a tiny unit test that schema `indexes()` includes expected keys (mongoose API), if stable across versions.

---

## 5. Acceptance criteria

- [x] All listed compound indexes declared in schema files
- [x] No duplicate conflicting unique indexes
- [x] README ops note for index build
- [x] No application logic changes required (unless fixing missing field definitions from 02)

---

## 6. Agent Notes

- **`reactor_nodes` Compound Indexes:** Added indexes for `{ projectId: 1, runId: 1 }`, `{ projectId: 1, parentId: 1 }`, `{ projectId: 1, type: 1 }`, `{ type: 1, name: 1 }`, and `{ projectFqn: 1, type: 1 }`.
- **`reactor_node_links` Compound Indexes:** Added indexes for `{ projectId: 1, runId: 1 }`, `{ source: 1, types: 1 }`, `{ target: 1, types: 1 }`, `{ projectId: 1, source: 1 }`, and `{ projectId: 1, target: 1 }` (in addition to existing `{ source: 1, target: 1 }`).
- **`reactor_projects` Index:** Verified unique sparse index `{ graphRootId: 1 }` on `ReactorProjectSchema`.
- **Production Ops Documentation:** Documented production index sync instructions in `services/SystemGraphManager.README.md`.
- **Tests:** Created unit test suite `services/graph/MongoIndexes.test.ts` verifying all declared single and compound schema indexes via Mongoose `schema.indexes()`. All tests passing.
