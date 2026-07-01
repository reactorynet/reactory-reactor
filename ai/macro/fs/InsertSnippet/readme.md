# InsertSnippet Macro

Inserts or replaces a snippet of text in a file at specified line positions.

## Usage
- **Macro:** `InsertSnippet`
- **Tool name:** `insertText`
- **Props:** `{ path: string, start: string, end?: string, snippet: string, exactMatch?: boolean }`
- **Returns:** `InsertSnippetResult` — a structured object with
  `success`, `data`, `error`, `errorCode`, `metadata`, and `instructions`
  fields (same shape as `WriteFileResult`).

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
in the snippet. The number of lines stripped from each edge is reported
in `data.trimmedLeading` and `data.trimmedTrailing` so the caller can
detect when the safety net fired.

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
entirely. When set, `data.trimmedLeading` and `data.trimmedTrailing`
will both be `0` and `data.exactMatch` will be `true`.

```json
{
  "path": "/project/src/app.ts",
  "start": "10",
  "end": "12",
  "snippet": "  if (x) {\n    return null;\n  }",
  "exactMatch": true
}
```

### Open-handle guard
Before mutating an existing file the macro checks (via `lsof` on POSIX,
skipped on Windows) that no other process holds the file open. If a
foreign PID holds it open the call fails with
`IO_PERMISSION_DENIED` and `operationType: 'blocked_open_handles'`. This
catches the "wrote successfully but file looks unchanged" race where a
watcher/formatter re-emits the old bytes.

### Post-write verification
After writing, the file is read back and the bytes on disk are compared
to the intended content. If they differ the call fails with
`IO_READ_WRITE_ERROR` and `operationType: 'verification_failed'`.

### Re-read After Edit
After each `insertText` call, line numbers in the file change. The
`instructions` field on the result reminds the AI to re-read the file
before making further edits. The AI must always use line numbers from a
fresh read of the current file state — never reuse line numbers from a
previous read after an edit has been applied.

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

## Result shape

On success:

```ts
{
  success: true,
  tool: 'insertText',
  params: InsertSnippetProps,
  data: {
    path, mode, operation, startLine, endLine,
    linesBefore, linesAfter, snippetLines, insertedLines,
    trimmedLeading, trimmedTrailing, exactMatch,
    totalLines, size, sizeFormatted
  },
  metadata: { executionTime, timestamp, user, fileExisted, operationType },
  instructions: '…'
}
```

On failure:

```ts
{
  success: false,
  tool: 'insertText',
  params: InsertSnippetProps,
  error: '…',
  errorCode: MacroErrorCode,
  metadata: { executionTime, timestamp, user, fileExisted, operationType }
}
```
