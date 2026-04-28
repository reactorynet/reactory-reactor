# InsertSnippet Macro

Inserts or replaces a snippet of text in a file at specified line positions.

## Usage
- **Macro:** `InsertSnippet`
- **Tool name:** `insertText`
- **Props:** `{ path: string, start: string, end?: string, snippet: string, exactMatch?: boolean }`
- **Returns:** Success or error message

## Modes

### INSERT mode (no `end`)
Inserts the snippet **before** line `start`. The original line at `start` and
all subsequent lines are preserved automatically.

### REPLACE mode (`start` and `end`)
Replaces lines `[start, end]` (inclusive, 1-based) with the snippet. Lines
before `start` and after `end` are preserved automatically.

## Safety Features

### Overlap Detection
If the snippet accidentally includes lines that already exist immediately
before `start` or after `end`, they are trimmed automatically to prevent
duplication. This guards against AI models that echo surrounding context
in the snippet.

The detection skips matches that consist entirely of "structural" lines
(blank lines, lone `}`, `]`, `)`, `};`, `],` etc.). Those match too
frequently across unrelated scopes to be a reliable signal of duplicated
context, and were the source of the most common false-positive class
(snippet ending with `}` getting its closing brace stripped because the
next file line is also a `}` closing a parent scope).

### `exactMatch` Escape Hatch
For precise edits where the snippet's very first or last line legitimately
matches the surrounding file content (and therefore would be stripped by
overlap detection), set `exactMatch: true` to bypass overlap trimming
entirely:

```json
{
  "path": "/project/src/app.ts",
  "start": "10",
  "end": "12",
  "snippet": "  if (x) {\n    return null;\n  }",
  "exactMatch": true
}
```

Use this when your snippet contains structural boundaries that belong to
the replaced block but happen to match the parent scope's boundaries.

### Re-read After Edit
After each `insertText` call, line numbers in the file change. The macro's
success message reminds the AI to re-read the file before making further edits.
The AI must always use line numbers from a fresh read of the current file state —
never reuse line numbers from a previous read after an edit has been applied.

## Examples

Insert before line 5:
```json
{
  "path": "/project/src/app.ts",
  "start": "5",
  "snippet": "// New import\nimport { foo } from './foo';"
}
```

Replace lines 10–15:
```json
{
  "path": "/project/src/app.ts",
  "start": "10",
  "end": "15",
  "snippet": "const result = computeValue();\nreturn result;"
}
```
