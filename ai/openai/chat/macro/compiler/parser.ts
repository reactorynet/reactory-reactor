import { CSTNode } from "../../../types/compiler/cst";
import { MacroTokenType, Token } from "../../../types/compiler/lexer";


export const createCST = (tokens: Token[]): CSTNode => {
  let current = 0;

  const cst: CSTNode = {
    type: 'Program',
    children: [],
  };

  const nextToken = (): Token => tokens[current++];

  const lookAhead = (): Token => tokens[current];

  const parseMacroInvocation = (): CSTNode => { 
    const node: CSTNode = {
      type: 'MacroInvocation',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseGrouping = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Grouping',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseChaining = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Chaining',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseBranching = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Branching',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseNesting = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Nesting',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseIfControl = (): CSTNode => { 
    const node: CSTNode = {
      type: 'IfControl',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseSwitchControl = (): CSTNode => { 
    const node: CSTNode = {
      type: 'SwitchControl',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseTryCatch = (): CSTNode => { 
    const node: CSTNode = {
      type: 'TryCatch',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseWhileLoop = (): CSTNode => { 
    const node: CSTNode = {
      type: 'WhileLoop',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseLiteral = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Literal',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseIdentifier = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Identifier',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseOperator = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Operator',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parsePunctuation = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Punctuation',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseWhitespace = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Whitespace',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseToken = (token: Token): CSTNode => { 
    switch (token.type.toString()) {
      case "IDENTIFIER":
        return parseIdentifier();
      case "MACRO_START":
        return parseMacroInvocation();
      case "PAREN_OPEN":
      case "BRACKET_OPEN":
        return parseGrouping();
      case "CURLY_OPEN":
        return parseNesting();
      case "ARROW_CHAIN":
        return parseChaining();      
      case "GROUPING" :
        return parseGrouping();
      case "CHAINING":
        return parseChaining();
      case "BRANCHING":
        return parseBranching();
      case "NESTING":
        return parseNesting();
      case "IF_CONTROL":
        return parseIfControl();
      case "SWITCH_CONTROL":
        return parseSwitchControl();
      case "TRY_CATCH":
        return parseTryCatch();
      case "WHILE_LOOP":
        return parseWhileLoop();
      case "LITERAL":
        return parseLiteral();
      case "IDENTIFIER":
        return parseIdentifier();
      case "OPERATOR":
        return parseOperator();
      case "PUNCTUATION":
        return parsePunctuation();
      case "WHITESPACE":
        return parseWhitespace();
      default:
        throw new Error(`Unexpected token type: ${token.type}`);
    }
  
  }

  // parse the main program
  while (current < tokens.length) {
    const token = nextToken(); 
    //parse the token 
    const node = parseToken(token);
    cst.children?.push(node);
  }

  return cst;
}


