# Module macros

The module macro provides several module specific functions. 

## Usage:

`@module(list)` - Lists all modules installed.
`@module(install, moduleName)` - Installs a module.
`@module(uninstall, moduleName)` - Uninstalls a module.
`@module(update, moduleName)` - Updates a module.
`@module(search, moduleName)` - Searches for a module.
`@module(info, moduleName)` - Provides information about a module.
`@module(activate, moduleName)` - Activates a module.
`@module(deactivate, moduleName)` - Deactivates a module.
`@module(activate, moduleName, version)` - Activates a module with a specific version.
`@module(deactivate, moduleName, version)` - Deactivates a module with a specific version.
`@module(create, moduleName, templateName?)` - Creates a new module
`@module(config, format?)` - Returns the current module configuration
