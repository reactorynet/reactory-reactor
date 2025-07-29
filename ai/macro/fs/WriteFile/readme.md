# WriteFile Macro

Writes content to a file on the filesystem. Supports various write modes (overwrite, create, append, prepend, insert). Only files within the user's home directory are allowed for security reasons.

## Usage
- **Macro:** `WriteFile`
- **Props:** `{ path: string, content: string, mode?: string, start?: string, end?: string }`
- **Returns:** Success or error message

## Example
```json
{
  "path": "~/Documents/example.txt",
  "content": "Hello, world!",
  "mode": "overwrite"
}
```
