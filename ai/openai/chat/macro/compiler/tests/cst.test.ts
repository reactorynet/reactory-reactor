import { CSTNode } from "@reactory/server-modules/reactor/ai/openai/types/compiler/cst";
import { createCST } from "../parser";
import { Token } from "@reactory/server-modules/reactor/ai/openai/types/compiler/lexer";
import { TokenisationMap } from "../mocks/tokens";
import { mockHelloWorldProgramNode } from "../mocks/cst";
import Tokenize from '../lexer';

describe('CST', () => {
  it('should create a CST node with type Program', () => {
    
    //given a token array
    const tokens: Token[] = TokenisationMap['@print("Hello, World!")'];

    //when we create a CST
    const cst = createCST(tokens);

    //then we expect the CST to have type Program
    expect(cst.type).toBe('Program');
    expect(cst).toEqual(mockHelloWorldProgramNode);    
  });

  it('should create a CST node with if statement', () => { 
    const tokens = Tokenize(`
    if ($name == "John") {
      @print("Hello, John!")
    }
    `, { ignoreWhitespace: false, ignoreNewLines: false });

    const cst = createCST(tokens);

    expect(cst).toEqual({ 
      type: 'Program',
      children: [
        {
          type: 'ControlFlow',
          value: 'if',
          children: [
            {
              type: 'Condition',
              value: '($name == "John")',
              children: [
                {
                  type: 'ComparisonOperator',
                  value: '==',
                  children: [],
                },
                {
                  type: 'Variable',
                  value: '$name',
                  children: [],
                },
                {
                  type: 'StringLiteral',
                  value: '"John"',
                  children: [],
                },
              ],
            },
            {
              type: 'MacroInvocation',
              value: '@',
              children: [
                {
                  type: 'MacroName',
                  value: 'print',
                  children: [],
                },
                {
                  type: 'MacroArguments',
                  value: '("Hello, John!")',
                  children: [
                    {
                      type: 'StringLiteral',
                      value: '"Hello, John!"',
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

});