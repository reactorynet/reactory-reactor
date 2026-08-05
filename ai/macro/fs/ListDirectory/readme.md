# ListDirectory Macro

Lists files and directories using concise shorthand. Only key data is provided.

## Shorthand item shape (per entry)
```ts
{ n: string, e?: string, s?: number, d: boolean, f: boolean, p?: string, m?: string }
// n=name, e=extension, s=size(bytes), d=isDir, f=isFile, p=path, m=modifiedISO
```

## Slim summary shape
```ts
{ t: number, f: number, d: number, s: number, sf: string }
// t=total, f=files, d=dirs, s=sizeBytes, sf=sizeFormatted
```

## Usage
- **Macro:** `ListDirectory`
- **Props:** `{ path: string, subfolders?: boolean, pattern?: string, format?: string, escape?: boolean }`
- **Returns:** Concise directory listing (text or JSON of shorthand items + slim summary)

## Example
```json
{
  "path": "~/Documents",
  "subfolders": true,
  "pattern": "*.txt",
  "format": "json"
}
```

Legend (text output): n=Name, e=Ext, s=Size(bytes), d=IsDir(bool), f=IsFile(bool), p=Path, m=Modified
