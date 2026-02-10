# Application Manager Macros

The application manager macro provides AI agents with tools to create, read, update, and export Reactory application (client) definitions. Each tool persists changes to MongoDB via the `ReactoryClientModel` and optionally writes YAML config files to disk.

## Available Tools

### `createApplication`
Create a new Reactory application definition.

**Required**: `key`, `name`  
**Optional**: `username`, `email`, `siteUrl`, `applicationRoles`, `billingType`, `theme`, `allowCustomTheme`, `whitelist`, `saveTo`

```
@createApplication(key: "my-app", name: "My Application", saveTo: "provision")
```

The `saveTo` parameter controls where YAML files are written:
- `personal` – writes to `~/.reactory/apps/<key>/`
- `provision` – writes to `src/data/clientConfigs/<key>/` and adds to `enabled-clients.reactory.json`
- `both` – writes to both locations

---

### `getApplication`
Retrieve a Reactory application by key.

**Required**: `key`  
**Optional**: `format` (`json` | `yaml` | `summary`)

```
@getApplication(key: "my-app", format: "summary")
```

---

### `listApplications`
List all registered Reactory applications.

**Optional**: `format` (`json` | `markdown` | `summary`)

```
@listApplications(format: "markdown")
```

---

### `updateApplicationThemes`
Set or replace the themes for an application.

**Required**: `key`, `themes`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationThemes(key: "my-app", themes: [...], saveTo: "both")
```

---

### `updateApplicationRoutes`
Define or replace URL routes for an application.

**Required**: `key`, `routes`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationRoutes(key: "my-app", routes: [...], saveTo: "both")
```

---

### `updateApplicationSettings`
Configure application-level settings.

**Required**: `key`, `settings`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationSettings(key: "my-app", settings: [...], saveTo: "both")
```

---

### `updateApplicationAuth`
Configure authentication providers.

**Required**: `key`, `auth_config`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationAuth(key: "my-app", auth_config: [...], saveTo: "both")
```

---

### `updateApplicationPlugins`
Register or update client-side plugins.

**Required**: `key`, `plugins`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationPlugins(key: "my-app", plugins: [...], saveTo: "both")
```

---

### `updateApplicationMenus`
Define navigation menus.

**Required**: `key`, `menus`  
**Optional**: `saveTo` (`database` | `yaml` | `both`)

```
@updateApplicationMenus(key: "my-app", menus: [...], saveTo: "both")
```

---

### `exportApplication`
Export an application from the database to YAML config files.

**Required**: `key`  
**Optional**: `saveTo` (`personal` | `provision`), `includeElements` (boolean)

```
@exportApplication(key: "my-app", saveTo: "provision", includeElements: true)
```

Writes `config.yaml` plus element files (`themes.yaml`, `routes.yaml`, `settings.yaml`, `plugins.yaml`, `whitelist.yaml`, `authentication/auth-config.yaml`) to the target directory.

---

## Tool Response Format

All tools return a consistent response structure for LLM consumption:

```json
{
  "success": true,
  "data": { "summary": { ... }, ... },
  "tool": "toolName",
  "params": { ... },
  "format": "json",
  "instructions": "## Markdown summary for the LLM..."
}
```

On failure:
```json
{
  "success": false,
  "error": "Human-readable error message",
  "tool": "toolName",
  "params": { ... }
}
```

## Chat State Variables

Each tool sets relevant state variables for downstream agent use:

| Variable | Set By |
|----------|--------|
| `lastCreatedApplication` | createApplication |
| `lastApplicationKey` | All tools |
| `lastRetrievedApplication` | getApplication |
| `listedApplications` | listApplications |
| `lastUpdatedThemes` | updateApplicationThemes |
| `lastUpdatedRoutes` | updateApplicationRoutes |
| `lastUpdatedSettings` | updateApplicationSettings |
| `lastUpdatedAuthConfig` | updateApplicationAuth |
| `lastUpdatedPlugins` | updateApplicationPlugins |
| `lastUpdatedMenus` | updateApplicationMenus |
| `lastExportedApplication` | exportApplication |
| `lastExportDir` | exportApplication |
