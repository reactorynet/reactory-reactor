# Extract Text From File Macro
Use this macro to replace a portion of text in a file.

## Usage
@insertText(/path/to/file, [start_index | [start_line, start_char], end_index | [end_line, end_char]], textToInsert)

The macro accepts three parameters, the filename, the start end end ranges defined as an array of number or array and the text to insert. This means the starting position for the grab can be defined by line or by line and character position or a combination thereof.
