import { ShellCommand } from './shell.macro';

import { ChatState } from "modules/reactor/types/chat.types";
import TestChatState from '../data/tests/mocks/ChatState';

describe('ShellCommand Macro', () => {

  // Setup
  let mockExec: jest.Mock;
  let chatState: ChatState = null;
  

  beforeEach(async () => {
    mockExec = jest.fn();
    // (exec as unknown as jest.Mock) = mockExec;
    chatState = await TestChatState({
      macros: [],
      roles: ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'],
    });
  });

  it('should execute the provided shell command', async () => {
    const shellCommand = 'echo \"Hello, World!\"';
    const expectedOutput = 'Hello, World!';
    
    const output = await ShellCommand([shellCommand], chatState);

    expect(output).toBe(expectedOutput);
  });

  it('should handle errors from command execution', async () => {
    const shellCommand = 'not_a_command';
    const expectedError = 'Command execution failed:';
    const output: string = await ShellCommand([shellCommand], chatState) as string;
    expect(output.indexOf(expectedError)).toBe(0);
  });

  it('should return a message when no command is provided', async () => {
    const output = await ShellCommand([], chatState);
    expect(output).toBe('No command provided');
  });
});
