# ReadChatFile Macro

Reads a file that is attached to the current chat session by its file ID. Unlike `readFile` which operates on filesystem paths, this macro reads files managed by the Reactory file service and validates that the file belongs to the active conversation.

## Usage
- **Macro:** `readChatFile`
- **Props:** `{ fileId: string }`
- **Returns:** File content as text (for text-based files) or metadata-only response (for binary files)

## Example
```json
{
  "fileId": "507f1f77bcf86cd799439011"
}
```

## Security
- Only files attached to the current conversation can be read
- Maximum readable file size is 512KB for text content
- Binary files return metadata only
