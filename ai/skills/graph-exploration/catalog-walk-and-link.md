# Reactor Graph: Catalog, Walk, Analyze & Link Skill

## Overview

This skill teaches you how to work with the Reactor system graph: catalog a
project so it exists in the graph, walk its nodes and edges, analyze the
underlying content, and — only when you have **hard evidence** — create edges
between elements that are verifiably linked. The system graph is shared,
persistent data consumed by other agents, workflows and the Graph Explorer
UI. Wrong edges pollute everyone's view; treat edge creation as a
high-confidence write operation.

## The Tool Inventory

### Project lifecycle (read/write)
| Tool | Purpose |
|------|---------|
| `listProjects` | Discover cataloged projects (ids, FQNs, repo paths). Start here. |
| `getProject` | Full detail on one project by id, FQN, name or repo path. |
| `catalogProject` | Register/refresh a project: detects types and processors, builds the graph. |

### Graph reads (all safe for auto-execution)
| Tool | Purpose |
|------|---------|
| `searchGraph` | Find node ids by name/description. Scope with `projectName` + `nameSpace` for indexed-content search. Your entry point. |
| `getGraphNode` | One node's detail (type, path, kind, ancestry key) + per-type edge counts. |
| `graphChildren` | Expand one level (folders → entries, files → symbols). Works on cataloged projects even before full indexing — this is the lazy filesystem walk. |
| `exploreGraph` | Bounded BFS neighbourhood (nodes + typed edges) over the **persisted** graph. Filter with `linkTypes`/`nodeTypes`; depth ≤ 3, capped output. |
| `graphLinks` | The full typed edge list touching one node, with resolved endpoint names. |

### Graph write (requires approval in safe_auto/plan modes)
| Tool | Purpose |
|------|---------|
| `createNodeEdge` | Create a typed edge between two node ids. Idempotent on (from, to, primary type). |

### Content analysis
Use `readFile` / `snip` / `shell` (grep) on the `path`/`relativePath` values
that graph nodes carry, to inspect actual file content. Node data tells you
*where* content lives; reading it is how you confirm relationships.

## Key Concepts

- **Node ids are deterministic hashes** — stable across sessions. An id you
  found yesterday still resolves today.
- **Ancestry keys** (`"rootId|...|nodeId"`) let the server re-materialize
  lazily-browsed nodes. When a tool returns a `key`, pass it back on
  follow-up calls (`getGraphNode`, `graphChildren`) for reliable resolution.
- **Lazy vs persisted**: `graphChildren` walks the live filesystem and works
  immediately after cataloging. `exploreGraph`/`graphLinks` only see nodes
  and edges **persisted by indexing** — a project that was cataloged but
  never processed has no persisted edges yet.
- **Edge types are semantic**:
  - `DEPENDENCY` — A requires B (imports, package deps, service deps)
  - `CALL` — A invokes B (function/method/API call)
  - `INHERITS` / `IMPLEMENTS` — class/interface relationships
  - `REFERENCE` — A mentions B (config keys, doc links, identifiers)
  - `CONNECTION` — runtime/infra connectivity (service ↔ datastore)
  - `INPUT` / `OUTPUT` — data-flow direction
  - `DIRECT` — generic association when nothing sharper applies (prefer sharper)
  - `SYMLINK` and `CONTAINS` are **system-managed** — never create them;
    `createNodeEdge` will refuse.

## Workflow

### Step 1 — Establish the project in the graph

```
@listProjects()                      # is it already cataloged?
@catalogProject(idOrPath: "...")     # if not — detects types + processors
```

After cataloging, verify with `getProject` that processors were detected.
Indexing (running the processors) is what persists file/symbol nodes and
analyzer-derived edges (imports, calls, inheritance) — the AST analyzers
already create those automatically for TypeScript, Python, Java and C#.
**Do not hand-create edges an analyzer would produce; re-index instead.**

### Step 2 — Walk the graph, outside in

1. `searchGraph(term: "...")` to find your entry node(s), or start from the
   project's root via `getProject`.
2. `getGraphNode(id)` to orient: type, path, edge counts by type.
3. `graphChildren(id, key)` to descend the containment tree one level at a
   time. Folders expand to entries, FILE nodes expand to their symbols.
   Symlink nodes never expand — follow their `SYMLINK` edge to the real
   target instead.
4. `exploreGraph(rootId, depth: 2, linkTypes: [...])` to see what is already
   connected. **Always do this before creating edges** — the relationship
   you are about to add may already exist, or the analyzer may have captured
   it with a sharper type.

Keep walks token-bounded: prefer filtered `exploreGraph` calls over
exhaustive `graphChildren` recursion, and page `graphChildren` (`pageSize`)
on large folders.

### Step 3 — Analyze content

For candidate relationships, read the actual content:

- Graph nodes carry `path` (repo-relative). Read the file (`readFile`, or
  `snip` for a slice of a large file) and locate the concrete reference:
  an import statement, a URL, a queue name, a config key, a class name.
- Find the counterpart node: `searchGraph` for the referenced artifact, then
  `getGraphNode` to confirm it is the right one (check its `path`, not just
  its name — many files share basenames).
- Cross-project links (e.g. service A calls service B's API) require
  evidence on **both** sides: the caller's client code/URL *and* the
  callee's matching route/endpoint definition.

### Step 4 — Create edges only at 100% confidence

The bar: **you can point to the exact line(s) of content that prove the
relationship, and you have verified both endpoint nodes are the artifacts
that content refers to.**

Qualifies:
- An import/require/using statement resolving to the target file (in-repo,
  path-verified) — though in-language imports are usually analyzer territory;
  prefer re-indexing.
- A config file naming another project's queue/topic/database/service id
  that you matched to that project's definition of it.
- An HTTP client calling a URL/route you matched to the target's route
  definition (`CALL`).
- A docker-compose/k8s manifest wiring service A to datastore B
  (`CONNECTION`).
- Documentation explicitly describing an integration you then verified in
  code (`REFERENCE` at minimum; the verified code relationship at best).

Does NOT qualify — do not create the edge:
- Name similarity ("both mention pricing").
- Directory adjacency or shared authorship.
- Inference from behavior you did not read the source of.
- Anything you would describe with "probably", "likely" or "seems to".

If a relationship is plausible but unproven, report it to the user as a
finding instead of writing it to the graph.

Creating the edge:

```
@createNodeEdge(
  from: <source node id>,          # the artifact that references
  to: <target node id>,            # the artifact being referenced
  types: ["CALL"],                 # sharpest applicable type first
  title: "POST /api/v1/quotes",    # the concrete reference
  description: "src/clients/pricing.ts:42 calls the quotes endpoint defined in zepz-pricing-engine src/routes/quotes.ts"
)
```

- **Direction matters**: `from` is the referrer, `to` is the referent.
- **Always set `title` and `description`** citing the evidence
  (file:line and what it says). The description is the audit trail that
  lets the next agent (or human) trust the edge.
- Edge ids are deterministic on (from, to, primary type): re-running updates
  rather than duplicates, so it is safe to refine title/description later.

### Step 5 — Verify

After creating edges, confirm with `graphLinks(id)` on one endpoint, or
`exploreGraph` over the area you worked on. Report to the user: which edges
you created, the evidence for each, and any plausible-but-unproven
relationships you deliberately did NOT create.

## Anti-patterns

1. **Bulk edge creation from a single grep.** Every edge needs its own
   verified evidence pair.
2. **Duplicating analyzer output.** If imports/calls/inheritance are missing
   for an analyzable language, the fix is `catalogProject` + re-index, not
   hand-created edges.
3. **Using `DIRECT` because choosing a type is effort.** The type IS the
   information; `DIRECT` is a last resort.
4. **Creating edges to placeholder nodes.** If `getGraphNode` shows a node
   named `#<id>` / "Unresolved node", resolve the real node first (walk to
   it via `graphChildren` with its ancestry key) — an edge to a wrong id is
   worse than no edge.
5. **Walking unbounded.** Depth-limit, filter, and page; the graph of a
   monorepo is bigger than your context window.
