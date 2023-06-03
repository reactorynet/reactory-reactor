# Macro - WriteFile
The `@out` macro is a macro that can read files and return the contents to reactor.

## Usage
`@out(filepath, referenceId?)`

### Params:
* `filepath` - the path to the file to read
* `referenceId` - optional reference id to use for the file

During chat with reactor, you can use the `@out(path/to/file, [1234])` macro to output responses from reactor to a file.