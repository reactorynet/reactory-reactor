# CreateModuleStructure Macro

Creates a new module file structure based on an array of file paths. Optionally generates file content using content generators mapped by regex patterns.

## Usage
- **Macro:** `CreateModuleStructure`
- **Props:** `{ fileStructure: string[], contentGenerators?: { pattern: string, generatorId: string }[] }`
- **Returns:** Success or error message for each file/directory

## Example
```json
{
  "fileStructure": [
    "~/Projects/module/index.ts",
    "~/Projects/module/components/index.ts"
  ],
  "contentGenerators": [
    { "pattern": "\\.(ts|tsx)$", "generatorId": "typescript.generator@1.0.0" }
  ]
}
```
