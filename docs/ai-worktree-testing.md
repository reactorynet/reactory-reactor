# Running a server module's tests from an AI worktree

`ProcessAITicket` prepares its worktree at `<express-server>/src/modules/reactory-worktrees/ai-<ref>`.
That is **one directory level deeper** than the module's natural home,
`<express-server>/src/modules/reactory-reactor`. This document explains why that breaks a
plain `jest` run, gives the one supported recipe, and states the exit-code contract that recipe
guarantees.

> **TL;DR**
>
> ```bash
> cd <worktree>
> node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
> node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats
> ```
>
> Exit **0** means every collected suite loaded and every test passed. Exit **1** means a suite
> failed to load, a test failed, or the wrapper could not run Jest.
>
> Do **not** hand-roll a Jest config. Do **not** "fix" it by rewriting imports.

---

## The symptom

```
Cannot find module '../../../database/tenant/ClientKeyColumn'
  from 'src/modules/reactory-worktrees/ai-<ref>/models/ReactorConversationMessage.ts'
Test Suites: 1 failed, 1 total
Tests:       0 total
```

Every suite that transitively imports `services/reactor/ReactorConversationService.ts` fails at
**load**, so it reports `0 tests`. In a log that is indistinguishable from "the suite ran and
found nothing", which is why this defect produced runs with no usable `testsRun` evidence
(REACTORY-302016408/20261104/1630018038).

## Why it happens

Module code reaches into the host server with relative specifiers written for the natural mount:

```ts
// models/ReactorConversationMessage.ts
import { ClientKeyColumn } from '../../../database/tenant/ClientKeyColumn';
//                               models/ -> reactor-reactor/ -> modules/ -> src/
```

Path arithmetic, from a file one directory below the module root:

| Module root                                    | `../../../` reaches    | `../../../database/...` |
| ---------------------------------------------- | ---------------------- | ----------------------- |
| `<server>/src/modules/reactory-reactor`         | `<server>/src`         | resolves ✓              |
| `<server>/src/modules/reactory-worktrees/ai-x`  | `<server>/src/modules` | `src/modules/database` ✗ |

The worktree root is deeper than the natural mount by exactly `depth - 1` levels, and every
relative specifier that **escapes** the module root is short by exactly that many `../`.

### Why the obvious workarounds do not work

| Attempt | Why it fails |
| ------- | ------------ |
| `moduleNameMapper` patterns (`^@reactory/server-modules/...`) | Mappers match **request strings**, not resolved locations. `../../../database/x` is not an alias, and the same `../../x` string means different things from different file depths, so no static pattern can express the correction. |
| Moving the worktree to `src/modules/reactory-reactor` | Collides with the primary checkout and duplicates the `@reactory/reactor` package in the server's `workspaces: ["src/modules/*"]` glob. |
| A symlink at the natural depth | Node/Jest resolve real paths, so relative resolution happens against the deep path again. |
| Rewriting all imports to aliases | Correct long term but a large mechanical change across the module; tracked separately (see "Follow-ups"). |

## The supported recipe

```bash
node scripts/ai/run-worktree-tests.js <test path or pattern> [more paths] [jest options]
```

Paths are **relative to the module root**; existing paths are resolved to absolute paths so Jest
matches them exactly. Other Jest flags pass through (`--listTests`, `-t`, `--maxWorkers`, …).
`--runInBand` is added unless you pass a run-mode flag.

```bash
# one suite
node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.conversationBudget.test.ts

# a directory and a second directory
node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats

# what would run
node scripts/ai/run-worktree-tests.js --listTests services/reactor/__tests__
```

The wrapper prints the resolved layout, the exact Jest command, and its own exit code:

```
[run-worktree-tests] module      src/modules/reactory-worktrees/ai-<ref>
[run-worktree-tests] server      /path/to/reactory-express-server
[run-worktree-tests] layout      relocated worktree: offset +1 level(s) vs the natural mount - the resolver re-anchors relative imports
[run-worktree-tests] target      services/reactor/__tests__
[run-worktree-tests] command     node .../jest.js --config .../jest-worktree.config.js --runInBand --forceExit ...
...
Test Suites: 55 passed, 55 total
Tests:       756 passed, 756 total
[run-worktree-tests] exit code 0 (every collected test passed)
```

## The exit-code contract

| Exit | Meaning |
| ---- | ------- |
| `0`  | Every collected suite loaded and every test passed. |
| `1`  | A suite failed to load, at least one test failed, or the wrapper could not run Jest (misconfiguration, missing install). |

`--forceExit` **is added by default** when the inherited server config sets `detectOpenHandles`,
and it is announced on stdout. It exists for one reason: this repository has async work that
survives teardown — Mongoose query middleware in `models/ReactorChatState.ts` calls `require()`
from its pre-hooks after the Jest environment is torn down — which makes Jest print
`ReferenceError: You are trying to import a file after the Jest environment has been torn down`
*after* an all-green summary and then exit 1.

That is a **false red**, and it is not specific to worktrees: the primary checkout does the same
with plain `npx jest` (verified: `src/modules/reactory-reactor/ai/macro/chats/macro.test.ts` reports
9/9 passed and exits 1). Because the ticket that produced this harness is about the *trustworthiness*
of a run's reported result, the wrapper reports what actually happened to the tests:

- a suite that fails to load still exits 1 (`Test suite failed to run`);
- a failed assertion still exits 1;
- `Test Suites: N passed` with no failures exits 0.

`--forceExit` cannot turn a failing run green. It only removes the post-teardown noise. Opt out
with `--no-forceExit` (or `REACTORY_WORKTREE_FORCE_EXIT=0`) if you need to see that noise as a
non-zero exit — for example while investigating a real leak.

## What the harness consists of

| File | Responsibility |
| ---- | -------------- |
| `scripts/ai/run-worktree-tests.js` | Entry point. Resolves the module root (`--module-root`, `REACTORY_MODULE_ROOT`, cwd), finds the host server, prints the layout and the exact command, applies the exit-code contract, and propagates the result. |
| `scripts/ai/jest-worktree.config.js` | Loads the **server's own** `jest.config.ts` so the transformer, setup files, ignore patterns and aliases are exactly the ones the module runs with at its natural mount. Overrides only: `rootDir` (stays at the server), `roots` (this worktree only), `modulePaths`, the module's own alias → this worktree, and the resolver. |
| `scripts/ai/load-server-jest-config.js` | Single loader for `<server>/jest.config.ts` (ts-node, transpile-only). Shared by the config and the CLI so the `detectOpenHandles` decision cannot drift from the config actually used. |
| `scripts/ai/worktree-jest-resolver.js` | Jest `resolver`: re-anchors relative specifiers that escape the module root by the measured offset. Everything else goes to the default resolver. |
| `scripts/ai/worktree-module-resolution.js` | Pure path arithmetic (mount depth, offset, correction) — no Jest dependency, unit tested. |
| `scripts/ai/__tests__/worktree-module-resolution.test.ts` | Guard tests for the path arithmetic: natural mount (offset 0), worktree (offset 1), deeper nesting (offset 2), inside-module requests untouched, bare specifiers untouched, `node_modules` untouched. |
| `scripts/ai/__tests__/run-worktree-tests.e2e.test.ts` | End-to-end tests for the **exit-code contract**: a known-green suite exits 0 with the expected counts, a failing assertion exits 1, and a suite that cannot load exits 1. |

Two details worth knowing, because both produced misleading failures during the original fix:

1. **The module alias must point at the worktree.** The server config maps
   `@reactory/server-modules/<module>/*` → the primary checkout. The worktree config puts a more
   specific mapping first so alias imports resolve to the worktree. Without that, the model is
   loaded twice (once by relative path, once through the alias) and Mongoose throws
   `OverwriteModelError: Cannot overwrite 'ReactorConversation' model once compiled` — an error
   that looks nothing like a resolution problem.
2. **Babel must not re-resolve aliases.** Both `<server>/jest.config.ts` (inline `babelConfig`) and
   `<server>/babel.config.js` configure `babel-plugin-module-resolver`. Babel rewrites
   `@reactory/server-modules/<module>/...` against its own `root: './src'` — i.e. to the
   **primary** checkout — before Jest's mapper sees the specifier, producing the same double-load.
   The config strips that plugin and disables Babel config discovery (`babelrc: false`,
   `configFile: false`), leaving Jest's `moduleNameMapper` as the single source of truth.
   Root-relative imports (`schema/reflection`) still work through Jest's `modulePaths`.

## Using the harness for a repository that does not ship it

`scripts/ai/` is currently committed in `reactory-reactor` only, so the plain
`node scripts/ai/run-worktree-tests.js` form applies **only inside that repository**. For any other
module the workflow resolves the recipe before the engineer starts and gives it in the ticket
message under "## Test recipe". The two supported forms are:

```bash
# a) the worktree ships the harness (reactory-reactor and anything that adopts it)
node scripts/ai/run-worktree-tests.js services/.../__tests__/Some.test.ts

# b) the worktree does not, but the server tree has a copy: point it at this worktree
node <server>/src/modules/reactory-reactor/scripts/ai/run-worktree-tests.js \
     --module-root <worktree> services/.../__tests__/Some.test.ts
```

`--module-root` (or `REACTORY_MODULE_ROOT`) is what makes one copy serve any module: the config
resolves the module root from it instead of from its own location. Verified by running a
`reactory-queue` suite from `/tmp` through the `reactory-reactor` copy (10/10 passed, exit 0,
`layout: natural mount: offset 0`).

If neither form is available, the workflow's fallback applies: run the repository's own documented
test command, record the command, exit code and counts, and report the run as blocked if it cannot
run from the worktree at all. Never hand-roll a Jest config to paper over it.

## Proving the recipe reports real results (both controls)

A recipe is only evidence if a green run is green **and** a red run is red. Run both:

```bash
# 1. INVERSE CONTROL - the green baseline must exit 0.
node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats
#  -> must report: Test Suites: 55 passed, 55 total / Tests: 756 passed, 756 total
#     and "exit code 0". A non-zero exit here is a defect in the harness, not in the tests.

# 2. FAILING CONTROL - break one assertion and confirm the run FAILS.
#    e.g. in services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
#         expect(result.value).toBe(64000);  ->  expect(result.value).toBe(64001);
node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
#  -> must report: Test Suites: 1 failed / Tests: 1 failed, 4 passed  and exit 1

# 3. Revert the assertion and confirm the run is green again (5 passed, exit 0).
```

Both controls are automated in `scripts/ai/__tests__/run-worktree-tests.e2e.test.ts`, which spawns
the real wrapper and asserts on the real exit status. The first iteration of this harness had the
unit tests green while the documented baseline exited 1 — that test exists so it cannot recur.

A run that cannot fail is not a test run. `Test suite failed to run` and `Tests: 0 total` are never
evidence either.

## Troubleshooting

| Symptom | Meaning / action |
| ------- | ---------------- |
| `could not resolve the module root to test` | Run from the worktree, pass `--module-root <worktree>`, or set `REACTORY_MODULE_ROOT`. |
| `could not find the host server checkout` | The worktree is not inside `reactory-express-server/src/modules/...`. Run from the server checkout, or set `REACTORY_SERVER_ROOT=/path/to/reactory-express-server`. |
| `no Jest installation at <server>/node_modules/jest/bin/jest.js` | The server's dependencies are not installed; run its package install first. |
| `Cannot find module '...'` still reported | The import is genuinely missing, or it escapes the module root by more than the measured offset. Check `[run-worktree-tests] layout` in the header and the guard tests. |
| `OverwriteModelError` | An alias resolved to the primary checkout. Confirm `moduleNameMapper` starts with the worktree-specific entry and that Babel's `module-resolver` is still stripped (`transform` in the config). |
| All tests pass but exit is 1 | Post-teardown async noise (see "The exit-code contract"). Re-run; the wrapper applies `--forceExit` by default. If you passed `--no-forceExit`, that noise is expected. |
| `Tests: 0 total` | No tests were collected. Check the path argument and that the file matches the server's `testMatch`. |

## Follow-ups (deliberately out of scope)

- Converting the module's `../../../`-style imports to `@reactory/server-modules/reactory-reactor/...`
  aliases would make the module depth-independent and remove the need for the resolver. That is a
  large mechanical change and needs its own risk assessment (REACTORY-302016408).
- The async work that survives teardown (`models/ReactorChatState.ts` pre-hooks calling
  `require("../models")`, reached from `ai/macro/chats/macro.ts:623`) is the reason `--forceExit` is
  needed. Fixing the lifecycle properly — awaiting the in-flight write in the suite, or using a
  lazily resolved module reference that is safe after teardown — would let the wrapper drop
  `--forceExit`. It needs its own ticket; it affects the primary checkout identically.
- Committing `scripts/ai/` into the other module repositories (it is written to derive the server
  root and the module mount id from `package.json`, so it can be copied verbatim), after which the
  `--module-root` form becomes a fallback rather than the path most runs take.
