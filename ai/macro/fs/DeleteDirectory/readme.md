# DeleteDirectory Macro

Removes directories at the specified paths. Only directories within the user's home directory are allowed for security reasons.

## Usage
- **Macro:** `DeleteDirectory`
- **Props:** `{ paths: string[] }`
- **Returns:** Success or error message for each path

## Example
```json
{
  "paths": ["~/Documents/old-folder"]
}
```
