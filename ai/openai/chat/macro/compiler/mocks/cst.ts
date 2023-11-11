import { CSTNode, CSTProgramNode } from "@reactory/server-modules/reactor/ai/openai/types/compiler/cst";

export const mockHelloWorldProgramNode: CSTProgramNode = {
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
  ]
};

