import { ShellCommand } from './workflow.ai.macro';
import { exec } from "child_process";
import { ChatState } from "modules/reactor/types/chat.types";
import TestChatState from '../tests/mocks/ChatState';

jest.mock("child_process");

describe('ShellCommand Macro', async () => {

  // Setup
  let mockExec: jest.Mock;
  const fakeChatState: ChatState = await TestChatState({ macros: [] }); // Fill with actual fake state data if needed

  beforeEach(() => {
    mockExec = jest.fn();
    (exec as unknown as jest.Mock) = mockExec;
  });

  it('should execute the provided shell command', async () => {
    const shellCommand = 'echo "Hello, World!"';
    const expectedOutput = 'Hello, World!\n';
    mockExec.mockImplementationOnce((cmd, callback) => callback(null, expectedOutput, null));

    const output = await ShellCommand([shellCommand], fakeChatState);

    expect(mockExec).toHaveBeenCalledWith(shellCommand, expect.any(Function));
    expect(output).toBe(expectedOutput);
  });

  it('should handle errors from command execution', async () => {
    const shellCommand = 'not_a_command';
    const expectedError = 'Command not found';
    mockExec.mockImplementationOnce((cmd, callback) => callback(new Error(expectedError), null, null));

    const output = await ShellCommand([shellCommand], fakeChatState);

    expect(mockExec).toHaveBeenCalledWith(shellCommand, expect.any(Function));
    expect(output).toBe(`Command execution failed: Error: ${expectedError}`);
  });

  it('should return a message when no command is provided', async () => {
    const output = await ShellCommand([], fakeChatState);

    expect(mockExec).not.toHaveBeenCalled();
    expect(output).toBe('No command provided');
  });
});
