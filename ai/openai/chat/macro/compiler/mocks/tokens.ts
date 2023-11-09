import { Token } from "@reactory/server-modules/reactor/ai/openai/types/compiler/lexer";

export const TokenisationMap: { [key: string]: Token[] } = {
  '@print("Hello, World!")': [
    { type: 'MACRO_START', value: '@', position: { line: 1, column: 1 } },
    { type: 'IDENTIFIER', value: 'print', position: { line: 1, column: 2 } },
    { type: 'PAREN_OPEN', value: '(', position: { line: 1, column: 7 } },
    { type: 'STRING_LITERAL', value: '"Hello, World!"', position: { line: 1, column: 8 } },
    { type: 'PAREN_CLOSE', value: ')', position: { line: 1, column: 23 } },
    { type: 'EOF', value: '', position: { line: 1, column: 24 } },
  ],
  '@print($name)': [
    { type: 'MACRO_START', value: '@', position: { line: 1, column: 1 } },
    { type: 'IDENTIFIER', value: 'print', position: { line: 1, column: 2 } },
    { type: 'PAREN_OPEN', value: '(', position: { line: 1, column: 7 } },
    { type: 'VARIABLE', value: '$name', position: { line: 1, column: 8 } },
    { type: 'PAREN_CLOSE', value: ')', position: { line: 1, column: 13 } },
    { type: 'EOF', value: '', position: { line: 1, column: 14 } },
  ],
  '@print($name, "Hello, World!")': [
    { type: 'MACRO_START', value: '@', position: { line: 1, column: 1 } },
    { type: 'IDENTIFIER', value: 'print', position: { line: 1, column: 2 } },
    { type: 'PAREN_OPEN', value: '(', position: { line: 1, column: 7 } },
    { type: 'VARIABLE', value: '$name', position: { line: 1, column: 8 } },
    { type: 'COMMA', value: ',', position: { line: 1, column: 13 } },
    { type: 'STRING_LITERAL', value: '"Hello, World!"', position: { line: 1, column: 15 } },
    { type: 'PAREN_CLOSE', value: ')', position: { line: 1, column: 30 } },
    { type: 'EOF', value: '', position: { line: 1, column: 31 } },
  ],
  '@print($name, 123)': [
    {
      type: "MACRO_START",
      value: "@",
      position: {
        line: 1,
        column: 1,
      },
    },
    {
      type: "IDENTIFIER",
      value: "print",
      position: {
        line: 1,
        column: 2,
      },
    },
    {
      type: "PAREN_OPEN",
      value: "(",
      position: {
        line: 1,
        column: 7,
      },
    },
    {
      type: "VARIABLE",
      value: "$name",
      position: {
        line: 1,
        column: 8,
      },
    },
    {
      type: "COMMA",
      value: ",",
      position: {
        line: 1,
        column: 13,
      },
    },
    {
      type: "NUMBER_LITERAL",
      value: "123",
      position: {
        line: 1,
        column: 15,
      },
    },
    {
      type: "PAREN_CLOSE",
      value: ")",
      position: {
        line: 1,
        column: 18,
      },
    },
    {
      type: "EOF",
      value: "",
      position: {
        line: 1,
        column: 19,
      },
    },
  ],
  '@if ($name == "John") { @print("Hello, John!") }': [
    {
      type: "MACRO_START",
      value: "@",
      position: {
        line: 1,
        column: 1,
      },
    },
    {
      type: "IF",
      value: "if",
      position: {
        line: 1,
        column: 2,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 4,
      },
    },
    {
      type: "PAREN_OPEN",
      value: "(",
      position: {
        line: 1,
        column: 5,
      },
    },
    {
      type: "VARIABLE",
      value: "$name",
      position: {
        line: 1,
        column: 6,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 11,
      },
    },
    {
      type: "COMPARISON_OPERATOR",
      value: "==",
      position: {
        line: 1,
        column: 12,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 14,
      },
    },
    {
      type: "STRING_LITERAL",
      value: "\"John\"",
      position: {
        line: 1,
        column: 15,
      },
    },
    {
      type: "PAREN_CLOSE",
      value: ")",
      position: {
        line: 1,
        column: 21,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 22,
      },
    },
    {
      type: "CURLY_OPEN",
      value: "{",
      position: {
        line: 1,
        column: 23,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 24,
      },
    },
    {
      type: "MACRO_START",
      value: "@",
      position: {
        line: 1,
        column: 25,
      },
    },
    {
      type: "IDENTIFIER",
      value: "print",
      position: {
        line: 1,
        column: 26,
      },
    },
    {
      type: "PAREN_OPEN",
      value: "(",
      position: {
        line: 1,
        column: 31,
      },
    },
    {
      type: "STRING_LITERAL",
      value: "\"Hello, John!\"",
      position: {
        line: 1,
        column: 32,
      },
    },
    {
      type: "PAREN_CLOSE",
      value: ")",
      position: {
        line: 1,
        column: 46,
      },
    },
    {
      type: "WHITESPACE",
      value: " ",
      position: {
        line: 1,
        column: 47,
      },
    },
    {
      type: "CURLY_CLOSE",
      value: "}",
      position: {
        line: 1,
        column: 48,
      },
    },
    {
      type: "EOF",
      value: "",
      position: {
        line: 1,
        column: 49,
      },
    },
  ],
  '@print(`Hello, @var($name)`)': [
    {
      type: "MACRO_START",
      value: "@",
      position: {
        line: 1,
        column: 1,
      },
    },
    {
      type: "IDENTIFIER",
      value: "print",
      position: {
        line: 1,
        column: 2,
      },
    },
    {
      type: "PAREN_OPEN",
      value: "(",
      position: {
        line: 1,
        column: 7,
      },
    },
    {
      type: "EXECUTABLE_STRING_LITERAL",
      value: "`Hello, @var($name)`",
      position: {
        line: 1,
        column: 8,
      },
    },
    {
      type: "PAREN_CLOSE",
      value: ")",
      position: {
        line: 1,
        column: 28,
      },
    },
    {
      type: "EOF",
      value: "",
      position: {
        line: 1,
        column: 29,
      },
    },
  ]
}