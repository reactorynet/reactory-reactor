// Define a type for all the possible node types in the CST
export type CSTNodeType =
  | 'Program'
  | 'MacroInvocation'
  | 'MacroName'
  | 'MacroArguments'
  | 'MacroArgument'
  | 'StringInterpolation'
  | 'StringLiteral'
  | 'Grouping'
  | 'Chaining'
  | 'Branching'
  | 'Nesting'
  | 'IfControl'
  | 'SwitchControl'
  | 'TryCatch'
  | 'WhileLoop'
  | 'Literal'
  | 'Identifier'
  | 'Operator'
  | 'Punctuation'
  | 'VariableIdentifier'
  | 'Whitespace'
  | 'Comment'
  | 'Newline'
  | 'EOF';

// The base type for all CST nodes
export interface CSTNode {
  type: CSTNodeType;
  value?: string; // For literals, identifiers, operators, etc.
  children?: CSTNode[];
}

// Specific CST Node interfaces can then be extended for each type of node
export interface CSTGroupingNode extends CSTNode {
  type: 'Grouping';
  open: CSTNode; // '(' or '['
  close: CSTNode; // ')' or ']'
}

export interface CSTChainingNode extends CSTNode {
  type: 'Chaining';
  // For chaining, there will be a sequence of macro invocations or groups connected by chaining operators
  sequence: CSTNode[];
}

export interface CSTBranchingNode extends CSTNode {
  type: 'Branching';
  condition: CSTNode;
  successBranch: CSTNode;
  failureBranch: CSTNode;
}

export interface CSTNestingNode extends CSTNode {
  type: 'Nesting';
  outer: CSTNode;
  inner: CSTNode[];
}

export interface CSTIfControlNode extends CSTNode {
  type: 'IfControl';
  condition: CSTNode;
  thenBranch: CSTNode;
  elifBranches?: CSTNode[]; // An array of elif branches, if any
  elseBranch?: CSTNode; // The else branch, if present
}

export interface CSTSwitchControlNode extends CSTNode {
  type: 'SwitchControl';
  discriminant: CSTNode;
  cases: CSTNode[];
}

export interface CSTTryCatchNode extends CSTNode {
  type: 'TryCatch';
  tryBlock: CSTNode;
  catchBlock: CSTNode;
}

export interface CSTWhileLoopNode extends CSTNode {
  type: 'WhileLoop';
  condition: CSTNode;
  body: CSTNode;
}

export interface CSTLiteralNode extends CSTNode {
  type: 'Literal';
  // Value is a string representation of the literal (e.g., "5", "'hello world'", "true")
}

export interface CSTIdentifierNode extends CSTNode {
  type: 'Identifier';
  // Value is the name of the identifier
}

export interface CSTOperatorNode extends CSTNode {
  type: 'Operator';
  // Value is the operator symbol (e.g., '+', '&&', '==')
}

export interface CSTPunctuationNode extends CSTNode {
  type: 'Punctuation';
  // Value is the punctuation symbol (e.g., ',', ';', '{', '}')
}

export interface CSTWhitespaceNode extends CSTNode {
  type: 'Whitespace';
  // Value could be ' ', '\t', '\n', etc.
}

// The root type for the CST
export interface CSTProgramNode extends CSTNode {
  type: 'Program';
  body: CSTNode[];
}
