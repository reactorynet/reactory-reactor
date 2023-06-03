# Macro - ReadFile
The `@file` macro is a macro that can read files and return the contents to reactor.

## Usage
`@file(filepath, referenceId?)`

### Params:
* `filepath` - the path to the file to read
* `referenceId` - optional reference id to use for the file

During chat with reactor, you can use the `@file(path/to/file, [1234])` macro to read files and return the contents to reactor.
The macro will return the contents of the file as a string wrapped in a code block using the correct mime type. If you provided 
and id, the code block will have an id reference in the code block. This is useful if you want to reference the file later in the chat.