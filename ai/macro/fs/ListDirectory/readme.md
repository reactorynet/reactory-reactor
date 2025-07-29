# ListDirectory Macro

Lists files and directories in a specified path. Supports filtering, formatting, and recursive listing of subfolders.

## Usage
- **Macro:** `ListDirectory`
- **Props:** `{ path: string, subfolders?: boolean, pattern?: string, format?: string, escape?: boolean }`
- **Returns:** Directory listing as text or JSON

## Example
```json
{
  "path": "~/Documents",
  "subfolders": true,
  "pattern": "*.txt",
  "format": "json"
}
```
