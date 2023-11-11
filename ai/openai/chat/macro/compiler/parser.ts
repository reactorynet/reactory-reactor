import { CSTNode } from "../../../types/compiler/cst";
import { ASTNode, ExpressionNode, MacroInvocationNode, ProgramNode, StringLiteralNode } from '../../../types/compiler/ast';
import { TokenType, Token } from "../../../types/compiler/lexer";
import { StringLiteral } from "typescript";


export const createCST = (tokens: Token[]): CSTNode => {
  let current = 0;

  const nextToken = (): Token => tokens[current++];
  const currentToken = (): Token => tokens[current];
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

  const parseGrouping = (openingType: TokenType): CSTNode => { 
    const node: CSTNode = {
      type: 'Grouping',
      children: [],
    };
    let token = nextToken();
    let closingType: TokenType;

    switch(openingType) { 
      case "PAREN_OPEN": {
        closingType = "PAREN_CLOSE";
        break;
      }
      case "BRACKET_OPEN": {
        closingType = "BRACKET_CLOSE";
        break;
      }
      case "CURLY_OPEN": {
        closingType = "CURLY_CLOSE";
        break;
      }
    }

    while(token.type !== closingType) { 
      const childNode = parseToken(token);
      node.children.push(childNode);
      token = nextToken();
    }

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

    // if control has to have a condition
    // brackets are optional
    // so our next token should be either a bracket, identifier, literal, or variable
    // if it's a bracket, we parse a grouping
    // if it's an identifier, literal, or variable, we parse a comparison
    // otherwise throw an error
    switch(token.type) {
      case "STRING_LITERAL": {
        node.type = "StringLiteral";
        node.value = token.value;
        break;
      }
      case "NUMBER_LITERAL": {
        node.type = "NumberLiteral";
        node.value = token.value;
        break;
      }
      case "BOOLEAN_LITERAL": { 
        node.type = "BooleanLiteral";
        node.value = token.value;
        break;
      }
      case "VARIABLE": {
        node.type = "VariableIdentifier";
        node.value = token.value;
        break;
      }
      case "MACRO_START": {
        node.type = "MacroInvocation";
        node.value = token.value;
        node.children.push(parseMacroInvocation(token));
        break;
      }
      case "PAREN_OPEN":  {
        node.type = "Grouping";
        node.value = token.value;
        node.children.push(parseGrouping(token.type));
        break;
      }
      case "BRACKET_OPEN":  {
        node.type = "Grouping";
        node.value = token.value;
        node.children.push(parseGrouping(token.type));
        break;
      }
      default: {
        throw new Error(`Unexpected token type: ${token.type}, STRING_LITERAL, NUMBER_LITERAL, BOOLEAN_LITERAL, VARIABLE, MACRO_START, PAREN_OPEN, or BRACKET_OPEN expected`);
      }
    }

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
    switch(token.type) {
      case "STRING_LITERAL": {
        node.type = "StringLiteral";
        node.value = token.value;
        break;
      }
      case "NUMBER_LITERAL": {
        node.type = "NumberLiteral";
        node.value = token.value;
        break;
      }
      case "BOOLEAN_LITERAL": { 
        node.type = "BooleanLiteral";
        node.value = token.value;
        break;
      }
      case "VARIABLE": {
        node.type = "VariableIdentifier";
        node.value = token.value;
        break;
      }
      case "MACRO_START": {
        node.type = "MacroInvocation";
        node.value = token.value;
        node.children.push(parseMacroInvocation(token));
        break;
      }
      case "PAREN_OPEN":
      case "CURLY_OPEN":
      case "BRACKET_OPEN":  {
        node.type = "Grouping";
        node.value = token.value;
        node.children.push(parseGrouping(token.type));
        break;
      }
      default: {
        throw new Error(`Unexpected token type: ${token.type}, STRING_LITERAL, NUMBER_LITERAL, BOOLEAN_LITERAL, VARIABLE, MACRO_START, PAREN_OPEN, or BRACKET_OPEN expected`);
      }
    }

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

  const parseVariableIdentifier = (): CSTNode => {
    const node: CSTNode = {
      type: 'VariableIdentifier',
      children: [],
    };
    const token = nextToken();
    node.value = token.value;
    return node;
  }

  const parseComparisonOperator = (): CSTNode => {
    const node: CSTNode = {
      type: 'ComparisonOperator',
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
      case "PAREN_CLOSE":
      case "BRACKET_CLOSE":
      case "CURLY_OPEN":
      case "CURLY_CLOSE":
        return parseGrouping(token.type);
      case "ARROW_CHAIN":
        return parseChaining();      
      case "COMPARISON_OPERATOR":
        return parseComparisonOperator();
      case "ARROW_BRANCH":
        return parseBranching();
      case "IF_CONTROL":
        return parseIfControl();
      case "SWITCH_CONTROL":
        return parseSwitchControl();
      case "TRY_CATCH":
        return parseTryCatch();
      case "WHILE_LOOP":
        return parseWhileLoop();
      case "STRING_LITERAL":
      case "BOOLEAN_LITERAL":
      case "HEXADECIMAL_LITERAL":
      case "LITERAL":
        return parseLiteral();
      case "OPERATOR":
        return parseOperator();
      case "PUNCTUATION":
        return parsePunctuation();
      case "VARIABLE":
        return parseVariableIdentifier();
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

export const createAST = (cst: CSTNode): ProgramNode => { 

  const parseProgram = (node: CSTNode): ProgramNode => { 
    const programNode: ProgramNode = {
      type: 'Program',
      body: [],
    };
    node.children.forEach(child => {
      const astNode = parseNode(child);
      programNode.body.push(astNode);
    });

    return programNode;
  }

  const parseMacroInvocation = (node: CSTNode): ASTNode => { 
    const macroInvocationNode: MacroInvocationNode = {
      type: 'MacroInvocation',
      name: null,
      arguments: [],
    };
    
    if(node.children.length < 1) throw new Error(`Macro name expected, none found in ${node.value}`);

    //first child is the macro name
    const macroNameNode = node.children[0];
    if(macroNameNode.type !== "MacroName") throw new Error(`Macro name expected, none found in ${macroNameNode.value}`);

    macroInvocationNode.name = macroNameNode.value;
    if(node.children.length > 1) {
      // add arguments if any
      for(let i = 1; i < node.children.length; i++) {
        const argumentNode = node.children[i];
        if(argumentNode.type !== "MacroArguments") throw new Error(`Macro arguments expected, none found in ${argumentNode.value}`);
        argumentNode.children.forEach(argument => {
          const astNode = parseNode(argument) as ExpressionNode;
          const validArgumentNodeTypes = [
            'StringLiteral',
            'StringInterpolation',
            'NumberLiteral',
            'BooleanLiteral',
            'Variable',
            'BinaryExpression',
            'UnaryExpression',
            'ConditionalExpression',
            'MacroInvocation',
            'MacroChain',
            'MacroBranch',
          ];
          if(!validArgumentNodeTypes.includes(astNode.type)) throw new Error(`Unexpected argument type: ${astNode.type}`);
          macroInvocationNode.arguments.push(astNode);
        });
      }
    }

    return macroInvocationNode;
  };

  const parseStringLiteral = (node: CSTNode): StringLiteralNode => {
    const stringLiteralNode: StringLiteralNode = {
      type: 'StringLiteral',
      value: node.value,
    };

    return stringLiteralNode;
  }
 

  const parseNode = (node: CSTNode): ASTNode => { 
    switch (node.type.toString()) {
      case "Program":
        return parseProgram(node);
      case "MacroInvocation":
        return parseMacroInvocation(node);
      // case "MacroArguments":
      //   return parseMacroArguments(node);
      // case "MacroArgument":
      //   return parseMacroArgument(node);
      // case "StringInterpolation":
      //   return parseStringInterpolation(node);
      case "StringLiteral":
        return parseStringLiteral(node);
      // case "Grouping":
      //   return parseGrouping(node);
      // case "Chaining":
      //   return parseChaining(node);
      // case "Branching":
      //   return parseBranching(node);
      // case "Nesting":
      //   return parseNesting(node);
      // case "IfControl":
      //   return parseIfControl(node);
      // case "SwitchControl":
      //   return parseSwitchControl(node);
      // case "TryCatch":
      //   return parseTryCatch(node);
      // case "WhileLoop":
      //   return parseWhileLoop(node);
      // case "Literal":
      //   return parseLiteral(node);
      // case "Identifier":
      //   return parseIdentifier(node);
      // case "Operator":
      //   return parseOperator(node);
      // case "Punctuation":
      //   return parsePunctuation(node);
      // case "VariableIdentifier":
      //   return parseVariableIdentifier(node);
      // case "Whitespace":
      //   return parseWhitespace(node);
      // case "Comment":
      //   return parseComment(node);
      // case "Newline":
      //   return parseNewline(node);
      // case "EOF":
      //   return parseEOF(node);
      default:
        throw new Error(`Unexpected token type: ${node.type}`);
    }
  }
  
  const node = parseNode(cst);
  if(node.type !== "Program") throw new Error(`Unexpected node type: ${node.type}`);
  return node as ProgramNode;
};
