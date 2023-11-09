import { CSTNode } from "@reactory/server-modules/reactor/ai/openai/types/compiler/cst";
import { createCST } from "../parser";
import { Token } from "@reactory/server-modules/reactor/ai/openai/types/compiler/lexer";
import { TokenisationMap } from "../mocks/tokens";
describe('CST', () => {
  it('should create a CST node with type Program', () => {
    
    //given a token array
    const tokens: Token[] = TokenisationMap['@print("Hello, World!")'];

    //when we create a CST
    const cst = createCST(tokens);

    //then we expect the CST to have type Program
    expect(cst.type).toBe('Program');
    expect(cst).toEqual({
      type: 'Program',
      children: [
        {
          type: 'MacroInvocation',
          value: '@',
          children: [
            {
              type: 'MacroName',
              children: [],
              value: 'print',
            },
            {
              type: 'MacroArguments',
              value: '("Hello, World!")',
              children: [
                {
                  type: 'StringLiteral',
                  children: [],
                  value: '"Hello, World!"',
                },
              ],
            },
          ],
        },
      ],
    });    
  });

});