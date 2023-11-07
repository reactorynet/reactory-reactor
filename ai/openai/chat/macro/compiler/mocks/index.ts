
import {
  LiteralNode,
  VariableNode,
  MacroNode,
  MacroGroupNode,
  MacroChainNode,
  MacroBranchNode,
  ControlFlowNode,
  ASTRoot,
} from '../../../../types/compiler/ast';
// Mocks for Literal values
export const mockNumberLiteral: LiteralNode = {
  type: 'Literal',
  value: 42,
};

export const mockStringLiteral: LiteralNode = {
  type: 'Literal',
  value: 'Hello, World!',
};

// Mock for Variable
export const mockVariable: VariableNode = {
  type: 'Variable',
  name: '$result',
};

// Mock for a simple Macro
export const mockSimpleMacro: MacroNode = {
  type: 'Macro',
  name: 'print',
  params: [mockStringLiteral],
};

// Mock for a Macro with a variable and literal as parameters
export const mockMacroWithVariable: MacroNode = {
  type: 'Macro',
  name: 'add',
  params: [mockNumberLiteral, mockVariable],
};

// Mock for a Macro Group
export const mockMacroGroup: MacroGroupNode = {
  type: 'MacroGroup',
  macros: [mockSimpleMacro, mockMacroWithVariable],
};

// Mock for a Macro Chain
export const mockMacroChain: MacroChainNode = {
  type: 'MacroChain',
  source: mockSimpleMacro,
  destination: mockMacroWithVariable,
};

// Mock for Macro Branching
export const mockMacroBranch: MacroBranchNode = {
  type: 'MacroBranch',
  condition: mockVariable, // This could be a more complex expression in a real case
  successPath: mockSimpleMacro,
  failurePath: mockMacroWithVariable,
};

// Mock for a Control Flow
export const mockControlFlow: ControlFlowNode = {
  type: 'ControlFlow',
  controlType: 'if',
  condition: mockVariable, // A more complex condition would be used in reality
  body: [mockSimpleMacro, mockMacroWithVariable],
};

// Mock for the AST Root
export const mockASTRoot: ASTRoot = {
  body: [mockMacroGroup, mockMacroChain, mockMacroBranch, mockControlFlow],
};
