/**
 * AST contains types for the Reactory Scripting Language that defines the
 * abstract syntax tree for the language.
 */

// Define a type for the different kinds of nodes
export type ASTNodeType = 'Macro' | 
  'MacroGroup' | 
  'MacroChain' | 
  'MacroBranch' | 
  'ControlFlow' | 
  'Literal' | 
  'Variable';

// Base interface for all nodes
export interface ASTNode {
  type: ASTNodeType;
}

// A node representing a macro call
export interface MacroNode extends ASTNode {
  type: 'Macro';
  name: string;
  params: ASTNode[];
}

// A node representing a group of macros to be executed sequentially
export interface MacroGroupNode extends ASTNode {
  type: 'MacroGroup';
  macros: ASTNode[];
}

// A node representing chained macros
export interface MacroChainNode extends ASTNode {
  type: 'MacroChain';
  source: MacroNode;
  destination: MacroNode;
}

// A node representing branching logic
export interface MacroBranchNode extends ASTNode {
  type: 'MacroBranch';
  condition: ASTNode; // This could be a complex expression that needs evaluating
  successPath: ASTNode;
  failurePath: ASTNode;
}

// A node for control flow structures such as 'if' or 'while'
export interface ControlFlowNode extends ASTNode {
  type: 'ControlFlow';
  controlType: 'if' | 'elif' | 'else' | 'switch' | 'while' | 'try' | 'catch';
  condition?: ASTNode; // Optional, not all control flows have conditions (e.g., 'else')
  body: ASTNode[]; // The body of the control flow structure
}

// A node representing literal values (e.g., strings, numbers)
export interface LiteralNode extends ASTNode {
  type: 'Literal';
  value: string | number | boolean;
}

// A node representing a variable (e.g., $out)
export interface VariableNode extends ASTNode {
  type: 'Variable';
  name: string;
}

// The root node of the AST
export interface ASTRoot {
  body: ASTNode[];
}
