# ReadFile Macro

Reads a file from the filesystem and returns its content as a code block. Only files within the user's home directory are allowed for security reasons.

## Usage
- **Macro:** `ReadFile`
- **Props:** `{ path: string, id?: string }`
- **Returns:** File content as a code block (with optional code block id)

## Example
```json
{
  "path": "~/Documents/example.txt"
}
```
