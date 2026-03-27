# Agent Mode Test Prompts

Quick prompts to verify each `ToolApprovalMode` behaves correctly.
Switch modes via the tool-approval dropdown in ChatInput before sending.

---

## 1. AUTO Mode

**What to expect:** Tools execute server-side without any client prompts. You see tool-call progress events but no approval dialogs.

### Prompt
```
List all files in the current project root directory, then read the package.json file and tell me the project name and version.
```

**Tools invoked:** `listDirectory` (safe) → `readFile` (safe)
**Pass criteria:**
- No approval dialogs appear
- Both tools execute automatically
- Response contains directory listing + package name/version

---

## 2. SAFE_AUTO Mode

**What to expect:** Safe tools (read-only) execute automatically. Unsafe tools trigger an approval prompt.

### Prompt
```
Read the file README.md from the project root, then write a one-line summary
to a new file called /tmp/reactory-test-summary.txt
```

**Tools invoked:** `readFile` (safe → auto) → `writeFile` (unsafe → prompt)
**Pass criteria:**
- `readFile` executes without prompting
- `writeFile` shows an approval dialog
- Approving completes the task; rejecting stops with an explanation

---

## 3. PROMPT Mode

**What to expect:** Every tool call shows an approval dialog regardless of safety.

### Prompt
```
What is today's date and time? Then list the installed modules.
```

**Tools invoked:** `datetime` (safe but prompted) → `modules` (safe but prompted)
**Pass criteria:**
- Both `datetime` and `modules` show approval dialogs
- Approving each one continues the flow
- Rejecting either stops or skips that tool

---

## 4. PLAN Mode

**What to expect:** Same split as SAFE_AUTO (safe tools auto-execute, unsafe prompt). Intended for planning workflows.

### Prompt
```
I need to understand the project structure. Read the package.json, list the
src directory, and then create a file /tmp/reactory-structure-notes.txt with
your findings.
```

**Tools invoked:** `readFile` (safe → auto) → `listDirectory` (safe → auto) → `writeFile` (unsafe → prompt)
**Pass criteria:**
- `readFile` and `listDirectory` auto-execute
- `writeFile` shows approval dialog
- Agent presents a coherent plan before executing

---

## Quick Smoke Test (all modes)

Use this single prompt and switch modes between sessions to compare behavior:

```
Read the file package.json from the project root and summarize it.
```

| Mode | Expected |
|------|----------|
| AUTO | `readFile` runs server-side, no prompt |
| SAFE_AUTO | `readFile` auto-executes (safe) |
| PROMPT | `readFile` shows approval dialog |
| PLAN | `readFile` auto-executes (safe) |
