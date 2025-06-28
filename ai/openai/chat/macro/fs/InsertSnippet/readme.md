# InsertSnippet Macro

Inserts or replaces a snippet of text in a file at specified line positions.

## Usage
- **Macro:** `InsertSnippet`
- **Props:** `{ path: string, start: string, end?: string, snippet: string }`
- **Returns:** Success or error message

## Example
```json
{
  "path": "~/Documents/example.txt",
  "start": "5",
  "end": "7",
  "snippet": "// Inserted code here"
}
```
