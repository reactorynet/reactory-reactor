import { ShellCommand } from './shell.macro';
import { exec } from "child_process";
import { ChatState } from "modules/reactor/types/chat.types";
import TestChatState from '../data/tests/mocks/ChatState';

jest.mock("child_process");

describe('ShellCommand Macro', () => {

  // Setup
  let mockExec: jest.Mock;
  let chatState: ChatState = null;
  

  beforeEach(async () => {
    mockExec = jest.fn();
    (exec as unknown as jest.Mock) = mockExec;
    chatState = await TestChatState({
      macros: [],
      roles: ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'],
    });
  });

  it('should execute the provided shell command', async () => {
    const shellCommand = 'echo \"Hello, World!\"';
    const expectedOutput = 'Hello, World!\n';
    // mockExec.mockImplementationOnce((cmd, callback) => callback(null, expectedOutput, null));

    const output = await ShellCommand([shellCommand], chatState);

    // expect(mockExec).toHaveBeenCalledWith(shellCommand, expect.any(Function));
    expect(output).toBe(expectedOutput);
  }, 10000);

  // it('should handle errors from command execution', async () => {
  //   const shellCommand = 'not_a_command';
  //   const expectedError = 'Command not found';
  //   mockExec.mockImplementationOnce((cmd, callback) => callback(new Error(expectedError), null, null));

  //   const output = await ShellCommand([shellCommand], chatState);

  //   expect(mockExec).toHaveBeenCalledWith(shellCommand, expect.any(Function));
  //   expect(output).toBe(`Command execution failed: Error: ${expectedError}`);
  // });

  // it('should return a message when no command is provided', async () => {
  //   const output = await ShellCommand([], chatState);

  //   expect(mockExec).not.toHaveBeenCalled();
  //   expect(output).toBe('No command provided');
  // });
});
