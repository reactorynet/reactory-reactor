import { StringLiteral } from "typescript";
import { ASTNode, MacroInvocationNode, ProgramNode, StringLiteralNode } from "../../../types/compiler/ast";
import Tokenize from './lexer';
import { createCST, createAST } from './parser';

export type ValidHost = 'cli' | 'server' | 'mock';
class ExecutionContext  {
  context: Reactory.Server.IReactoryContext;
  host: ValidHost;
  state: Map<string, any> = new Map();
  functions: Map<string, Function> = new Map();


  constructor(context: Reactory.Server.IReactoryContext, host: ValidHost) {
    this.context = context;
    this.host = host;
    this.setupFunctions();
  }

  setupFunctions() {
    this.functions.set('print', (args: any[]) => {
      console.log(...args);
    });
  }

  get(key: string) {
    return this.state.get(key);
  }

  set(key: string, value: any) {
    this.state.set(key, value);
  }

  has(key: string) {
    return this.state.has(key);
  }

  executeFunction(name: string, args: any[]) { 
    const fn = this.functions.get(name);
    if (!fn) {
      throw new Error(`Function ${name} not found`);
    }
    return fn(args);
  }
}
 
export const createContext = (context: Reactory.Server.IReactoryContext, host: 'cli' | 'server' | 'mock') => {
  return new ExecutionContext(context, host);
}

export const executeProgram = async (programNode: ProgramNode, context: ExecutionContext) => {
  for (const node of programNode.body) {
    await executeNode(node, context);
  }
}

export const execute = async (input: string, context: ExecutionContext) => { 
  const tokens = Tokenize(input, { ignoreWhitespace: false });
  const cst = createCST(tokens);
  const ast = createAST(cst);
  await executeProgram(ast, context);
}

const executeMacro = async (macroNode: MacroInvocationNode, context: ExecutionContext) => { 
  const args = await Promise.all(macroNode.arguments.map(arg => executeNode(arg, context)));
  context.executeFunction(macroNode.name, args);
}

const executeNode = (node: ASTNode, context: ExecutionContext) => {
  switch (node.type) {
    case 'MacroInvocation':
      return executeMacro(node as MacroInvocationNode, context);
    // case 'MacroChain':
    //   return executeMacroChain(node, context);
    // case 'MacroBranch':
    //   return executeMacroBranch(node, context);
    // case 'ControlFlow':
    //   return executeControlFlow(node, context);
    case 'StringLiteral':
      return (node as StringLiteralNode).value;
    default:
      throw new Error(`Unknown node type ${node.type}`);
  }
}
