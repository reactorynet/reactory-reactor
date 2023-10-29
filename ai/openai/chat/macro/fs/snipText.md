# Extract Text From File Macro
Use this macro to get a portion of text from a file by specifying the file path, the start line and the end line.

## Usage
@snipText(/path/to/file, [start_index | [start_line, start_char], end_index | [end_line, end_char]])

The macro accepts two parameters, the filename and the start end end ranges defined as an array of number or array. This means the starting position for the grab can be defined by line or by line and character position or a combination thereof.
