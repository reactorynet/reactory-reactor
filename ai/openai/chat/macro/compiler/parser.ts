import { CSTNode } from "../../../types/compiler/cst";
import { MacroTokenType, Token } from "../../../types/compiler/lexer";


export const createCST = (tokens: Token[]): CSTNode => {
  let current = 0;

  const nextToken = (): Token => tokens[current++];
  const peekToken = (): Token => tokens[current + 1];

  const parseStringInterpolation = (currentArgumentToken: Token): CSTNode => {
    const stringInterpolationNode: CSTNode = {
      type: 'StringInterpolation',
      value: currentArgumentToken.value,
      children: [],
    };
    
    return stringInterpolationNode;
  }

  const parseMacroInvocation = (currentToken: Token): CSTNode => { 
    const macroTagNode: CSTNode = {
      type: 'MacroInvocation',
      value: currentToken.value,
      children: [],
    };
    const identifierToken = nextToken();

    if(identifierToken.type !== "IDENTIFIER") throw new Error(`Unexpected token type: ${identifierToken.type}, IDENTIFIER expected`);
    
    macroTagNode.children.push({
      type: 'MacroName',
      value: identifierToken.value,
      children: [],
    });

    const openParenToken = nextToken();
    if(openParenToken.type !== "PAREN_OPEN") throw new Error(`Unexpected token type: ${openParenToken.type}, PAREN_OPEN expected`);

    macroTagNode.children.push({
      type: 'MacroArguments',
      value: openParenToken.value,
      children: [],
    });

    let currentArgumentToken = nextToken();
    while(currentArgumentToken.type !== "PAREN_CLOSE") {
      const argumentNode: CSTNode = {
        type: 'MacroArgument',
        children: [],
      };

      macroTagNode.children[1].value += currentArgumentToken.value;

      switch(currentArgumentToken.type) {
        case "STRING_LITERAL": {
          argumentNode.type = "StringLiteral";
          argumentNode.value = currentArgumentToken.value;
          break;
        }
        case "EXECUTABLE_STRING_LITERAL": {
          argumentNode.type = "StringInterpolation";
          argumentNode.value = currentArgumentToken.value;
          argumentNode.children.push(parseStringInterpolation(currentArgumentToken));
          break;
        }
        case "VARIABLE": {
          argumentNode.type = "VariableIdentifier";
          argumentNode.value = currentArgumentToken.value;
          break;
        }
        case "MACRO_START": {
          argumentNode.type = "MacroInvocation";
          argumentNode.value = currentArgumentToken.value;
          argumentNode.children.push(parseMacroInvocation(currentArgumentToken));
          break;
        }
        default: {
          throw new Error(`Unexpected token type: ${currentArgumentToken.type}, STRING_LITERAL or VARIABLE expected`);
        }
      }
      macroTagNode.children[1].children.push(argumentNode);
      currentArgumentToken = nextToken();
    } 

    macroTagNode.children[1].value += currentArgumentToken.value;
    return macroTagNode;
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

  const parseComment = (): CSTNode => { 
    const node: CSTNode = {
      type: 'Comment',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseEOF = (): CSTNode => {     
    return null;
  }

  const parseToken = (token: Token): CSTNode => { 
    switch (token.type.toString()) {
      case "IDENTIFIER":
        return parseIdentifier();
      case "MACRO_START":
        return parseMacroInvocation(token);
      case "PAREN_OPEN":
      case "BRACKET_OPEN":
        return parseGrouping();
      case "PAREN_CLOSE":
      case "BRACKET_CLOSE":
        return parseGrouping();
      case "CURLY_OPEN":
      case "CURLY_CLOSE":
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
      case "COMMENT":
        return parseComment();
      case "NEWLINE":
        return parseWhitespace();
      case "EOF":
        return parseEOF();
      default:
        throw new Error(`Unexpected token type: ${token.type}`);
    }
  
  }

  // Create the root node
  const cst: CSTNode = {
    type: 'Program',
    children: [],
  };

  // parse the main program
  while (current < tokens.length) {
    const token = nextToken(); 
    //parse the token 
    const node = parseToken(token);
    if(node) cst.children.push(node);
  }

  return cst;
}




