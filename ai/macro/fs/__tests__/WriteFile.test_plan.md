# WriteFile Test Plan

Covers `WriteFile` macro at `fs/WriteFile/WriteFile.ts`. Exercises the guards added to
catch the "tool reports success but file unchanged" class of bug: verbatim writes,
post-write verification, and open-handle detection via `lsof`.

## Scope

- Input validation and `errorCode` population.
- Write semantics for every mode (`create`, `overwrite`, `append`, `prepend`, `insert`).
- Verbatim write — trailing whitespace and newlines are preserved.
- Post-write verification — on-disk bytes match intended bytes.
- Open-handle detection — blocks writes when another process holds the file.
- Code-block extraction.
- Error mapping for filesystem error codes.

## Strategy

- Real filesystem under `os.tmpdir()` so we test actual on-disk behavior, not a mock.
- Mock `child_process.execFile` so each test controls what `lsof` reports. Default
  is "no open handles" (exit code 1) so the macro proceeds.
- Mock `fs.promises.readFile` **once** (via `mockImplementationOnce`) for the single
  case that needs to simulate on-disk content diverging from intended content.
- Mock `@reactory/server-core/logging` so log calls don't noise up the suite.

## Test groups

### 1. Validation
- empty `path` → `VALIDATION_REQUIRED_PARAM`
- empty `content` → `VALIDATION_REQUIRED_PARAM`
- `mode: 'create'` on an existing file → `VALIDATION_INVALID_PARAM`
- `mode: 'insert'` with `end < start` → `VALIDATION_INVALID_PARAM`

### 2. Happy-path writes (per mode, verbatim)
- `create` writes a new file with exact bytes (including trailing newline).
- `overwrite` replaces existing content byte-for-byte.
- `append` concatenates `<existing>\n<trimmed new>` (documents existing trim
  of the *input*, not the *output*).
- `prepend` concatenates `<trimmed new>\n<existing>`.
- `insert` replaces line range start-end (1-based) with the provided content.
- A content payload with trailing whitespace is written verbatim by `overwrite`
  — this is the regression guard for the "file unchanged" bug where `.trim()` on
  the write silently discarded trailing bytes.

### 3. Code-block extraction
- Content wrapped in ```lang ... ``` fences has the inner payload extracted and
  written. Multiple fenced blocks are joined with `\n`.

### 4. Open-handle detection
- `lsof` reports a foreign PID → macro returns `IO_PERMISSION_DENIED`, original
  file content is untouched.
- `lsof` reports only our own PID → macro proceeds normally.
- `lsof` reports no handles (exit code 1) → macro proceeds normally.
- `lsof` fails with an unexpected error (e.g. ENOENT binary missing) → macro
  still proceeds (best-effort) and logs a warning.
- Create mode on a non-existent path → `lsof` is not consulted at all.

### 5. Post-write verification
- When `fs.readFile` returns content that differs from what the macro wrote,
  the macro returns `IO_READ_WRITE_ERROR` and surfaces expected/actual byte
  counts in the error message.
- Verification mismatch is logged at error level.

### 6. Error path mapping
- A thrown `EACCES` error during write maps to `IO_PERMISSION_DENIED`.
- A thrown `ENOENT` error during write maps to `IO_NOT_FOUND` (e.g. writing
  into a non-existent directory).
- Any other thrown error maps to `IO_READ_WRITE_ERROR`.

## Non-goals

- GPU-like race conditions between external processes and the macro. We only
  assert the macro's *response to* evidence of concurrent access (via `lsof`)
  and *response to* divergent on-disk content (via the verification read). We
  don't try to reproduce an actual race.
- Windows-specific handle detection. The macro intentionally skips `lsof` on
  `win32`; we note this but don't add a Windows branch to the suite since CI
  runs on Linux/macOS.
