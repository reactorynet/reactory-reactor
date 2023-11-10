import {
  mockProgramNode,
  mockSimpleMacro,
  mockMacroGroup,
  mockMacroChain,
  mockMacroBranch,
  mockControlFlow,  
} from '../mocks';

import { createCST, createAST } from "../parser";
import { Token } from "@reactory/server-modules/reactor/ai/openai/types/compiler/lexer";
import { TokenisationMap } from "../mocks/tokens";


// Mock functions (these would be replaced with actual implementations)
const parse = jest.fn((input: string) => {
  return mockProgramNode;
});
const executeMacro = jest.fn();
const evaluateCondition = jest.fn();
const executeControlFlow = jest.fn();

describe('AST', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return an AST', () => {
    // given an input string
    const input = '@print("Hello, World!")';
    // when we parse the input
    const cst = createCST(TokenisationMap[input]);

    const ast = createAST(cst);    
    // and we expect the parse function to return the AST root
    expect(ast.type).toEqual('Program');
  });
});
