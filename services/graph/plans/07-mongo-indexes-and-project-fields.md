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

- [ ] All listed compound indexes declared in schema files
- [ ] No duplicate conflicting unique indexes
- [ ] README ops note for index build
- [ ] No application logic changes required (unless fixing missing field definitions from 02)

---

## 6. Agent Notes
