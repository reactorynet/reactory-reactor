import { Token, Tokenizer, MacroTokenType } from '../../../types/compiler/lexer';

// The tokenizer function takes a string of macro code and returns an array of tokens
const tokenize: Tokenizer = (input: string): Token[] => {
  const tokens: Token[] = [];
  let position = { line: 1, column: 1 };

  // Regular expressions for the different tokens, ensure to include all necessary patterns
  const tokenPatterns: [RegExp, MacroTokenType][] = [
    [/^\s+/, 'WHITESPACE'], // Ignore whitespace
    [/^@/, 'MACRO_START'],
    [/^\(/, 'PAREN_OPEN'],
    [/^\)/, 'PAREN_CLOSE'],
    [/^\[/, 'BRACKET_OPEN'],
    [/^\]/, 'BRACKET_CLOSE'],
    [/^\{/, 'CURLY_OPEN'],
    [/^\}/, 'CURLY_CLOSE'],
    [/^,/, 'COMMA'],
    [/^;/, 'SEMICOLON'],
    [/^-->/, 'ARROW_CHAIN'],
    [/^-=>/, 'ARROW_SUCCESS'],
    [/^\$[a-zA-Z_]\w*/, 'VARIABLE'],
    [/^"[^"\\]*(\\.[^"\\]*)*"/, 'STRING_LITERAL'], // String literals with escape characters
    [/^\d+(\.\d+)?/, 'NUMBER_LITERAL'],
    [/^(?:&&|\|\|)/, 'LOGICAL_OPERATOR'],
    [/^(?:==|!=|<=|>=|<|>)/, 'COMPARISON_OPERATOR'],
    [/^=/, 'ASSIGNMENT'],
    [/^if\b/, 'IF'],
    [/^else\b/, 'ELSE'],
    [/^elif\b/, 'ELIF'],
    [/^for\b/, 'FOR'],
    [/^while\b/, 'WHILE'],
    [/^do\b/, 'DO'],
    [/^switch\b/, 'SWITCH'],
    [/^case\b/, 'CASE'],
    [/^break\b/, 'BREAK'],
    [/^continue\b/, 'CONTINUE'],
    [/^return\b/, 'RETURN'],
    [/^try\b/, 'TRY'],
    [/^catch\b/, 'CATCH'],
    [/^finally\b/, 'FINALLY'],
    [/^throw\b/, 'THROW'],
    [/^goto\b/, 'GOTO'],
    [/^with\b/, 'WITH'],
    [/^yield\b/, 'YIELD'],
    [/^async\b/, 'ASYNC'],
    [/^await\b/, 'AWAIT'],
    [/^[a-zA-Z_]\w*/, 'IDENTIFIER'],
    // Add other patterns if needed
  ];

  // Function to update position
  const updatePosition = (text: string) => {
    for (let char of text) {
      if (char === '\n') {
        position.line++;
        position.column = 0;
      } else {
        position.column++;
      }
    }
  };

  while (input.length > 0) {
    let matched = false;

    for (const [pattern, type] of tokenPatterns) {
      const match = pattern.exec(input);
      if (match) {
        const [text] = match;
        if (type !== 'WHITESPACE') { // WHITESPACE is ignored
          tokens.push({ type, value: text, position: { ...position } });
        }
        updatePosition(text);
        input = input.slice(text.length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error(`Unexpected token at line ${position.line}, column ${position.column}`);
    }
  }

  return tokens;
};

export default tokenize;