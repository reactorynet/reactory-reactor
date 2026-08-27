# Copy-paste agent handoff prompt

Replace `SESSION_FILE` with e.g. `01-persist-folder-hierarchy.md`.

```text
You are a coding agent implementing ONE SystemGraph improvement session.

## Mandatory reading (in order)
1. src/modules/reactory-reactor/services/graph/plans/00-README.md
2. src/modules/reactory-reactor/services/graph/plans/SESSION_FILE

## Working directory
reactory-express-server/

## Rules
- Implement ONLY this session. Do not start dependent later sessions.
- Respect the Allowed files list; do not drive-by refactor.
- Preserve GraphIdentity invariants (I1–I9 in 00-README).
- Load tree-sitter ONLY via TreeSitterEngine.
- Prefer small patches; TDD with listed tests.
- Use ./bin/jest.sh if present, else:
  NODE_OPTIONS=--max-old-space-size=6144 npx jest <paths> --forceExit
- Branch name is specified in the session doc.
- When finished: fill ## Agent Notes in the session markdown, mark acceptance checkboxes, summarize diff.

## Done means
All Acceptance criteria checked and listed tests green.
```

## Suggested dispatch order

Wave A: `01`  
Wave B: `02`, `03`, `04` (02 after 01 merges)  
Wave C: `05`, `07`, `10`, `11`  
Wave D: `06`, `08`  
Wave E: `09`, `12`, `13`  
Wave F: `14`  
Wave G: `15` — **hardening (required before production)** — file: `15-hardening-orchestration-gc-facade.md`

### If 01–14 are already on master

Start with Session **15** only:

```text
SESSION_FILE=15-hardening-orchestration-gc-facade.md
```
