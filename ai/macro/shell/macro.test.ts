import { ShellCommand, secureShell } from './macro';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import TestChatState from '../data/tests/mocks/ChatState';
import { ShellCommandProps } from './types';

/**
 * ShellCommand takes a ShellCommandProps object (not the deprecated positional
 * ShellCommandArgs tuple) and resolves a structured ShellCommandResult rather
 * than a bare string. Failures are returned as `{ success: false, error }`, not
 * thrown, so the AUTO loop can feed them back to the model.
 *
 * The command text is rendered through core.TemplateService, which needs a
 * database. These tests stub that service on the context so the execution path
 * is exercised deterministically and offline; everything before it (argument
 * validation, the security gate) needs no stub at all.
 */

/** A TemplateService stub that renders the command verbatim. */
const stubTemplateService = (state: ChatState) => {
  const templateService = {
    getTemplate: jest.fn().mockResolvedValue(null),
    renderTemplate: jest.fn(async (template: string, props: Record<string, any>) =>
      // Mirrors the real ejs render of DEFAULT_SHELL_TEMPLATE: env exports then
      // the command.
      `${props.environmentVars ?? ''}\n${props.command}\n`
    ),
  };
  (state.context as any).getService = jest.fn((id: string) =>
    id.startsWith('core.TemplateService') ? templateService : null
  );
  return templateService;
};

const EXEC_ROLES = ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'];

describe('ShellCommand macro', () => {
  let chatState: ChatState;

  beforeEach(async () => {
    chatState = await TestChatState({ macros: [], roles: EXEC_ROLES });
  });

  describe('argument validation', () => {
    it('reports a missing command instead of throwing', async () => {
      const result = await ShellCommand({ command: '' } as ShellCommandProps, chatState);
      expect(result).toMatchObject({
        success: false,
        error: 'No command provided',
        tool: 'shell',
      });
      expect(result.metadata?.timestamp).toBeInstanceOf(Date);
    });

    it('reports a whitespace-only command as missing', async () => {
      const result = await ShellCommand({ command: '   ' } as ShellCommandProps, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No command provided');
    });

    it('reports a working directory that does not exist', async () => {
      const result = await ShellCommand(
        { command: 'echo hi', workingDir: '/does/not/exist/anywhere' },
        chatState
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Working directory .* does not exist/);
    });
  });

  describe('security gate', () => {
    it('refuses a command when the user lacks an execution role', async () => {
      const unauthorised = await TestChatState({ macros: [], roles: ['USER'] });
      const result = await ShellCommand({ command: 'echo hi' }, unauthorised);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Security Check Failed/);
      expect(result.error).toMatch(/does not have the necessary role/);
    });

    it.each(['rm -rf /tmp/x', 'chmod 777 /etc/passwd', 'shutdown -h now', 'curl http://evil'])(
      'refuses the dangerous command %p',
      async (command) => {
        const result = await ShellCommand({ command }, chatState);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Security Check Failed/);
      }
    );

    it('refuses everything when DENY_SHELL_EXECUTION is set', async () => {
      const previous = process.env.DENY_SHELL_EXECUTION;
      process.env.DENY_SHELL_EXECUTION = 'true';
      try {
        const result = await ShellCommand({ command: 'echo hi' }, chatState);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Shell execution is disabled/);
      } finally {
        if (previous === undefined) delete process.env.DENY_SHELL_EXECUTION;
        else process.env.DENY_SHELL_EXECUTION = previous;
      }
    });

    it('secureShell throws rather than returning, so callers must catch', () => {
      expect(() => secureShell('rm -rf /', chatState)).toThrow(/potentially dangerous/);
      expect(() => secureShell('echo safe', chatState)).not.toThrow();
    });
  });

  describe('execution', () => {
    it('runs the command and returns its stdout', async () => {
      stubTemplateService(chatState);
      const result = await ShellCommand({ command: 'echo "Hello, World!"' }, chatState);
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data?.stdout).toContain('Hello, World!');
      expect(result.data?.exitCode).toBe(0);
      expect(result.data?.timedOut).toBe(false);
      expect(result.data?.command).toBe('echo "Hello, World!"');
    });

    it('reports a non-zero exit code without failing the macro call', async () => {
      stubTemplateService(chatState);
      // The macro succeeded in *running* the command; the command itself failed.
      const result = await ShellCommand({ command: 'exit 3' }, chatState);
      expect(result.success).toBe(true);
      expect(result.data?.exitCode).toBe(3);
      expect(result.data?.success).toBe(false);
    });

    it('executes in the requested working directory', async () => {
      stubTemplateService(chatState);
      const workingDir = process.env.REACTORY_HOME || process.cwd();
      const result = await ShellCommand({ command: 'pwd', workingDir }, chatState);
      expect(result.success).toBe(true);
      // macOS reports /private/var for /var, so compare the resolved tail.
      expect(result.data?.stdout.trim()).toContain(require('path').basename(workingDir));
      expect(result.data?.workingDir).toBe(workingDir);
    });

    it('records the last command on the chat state for later macros', async () => {
      stubTemplateService(chatState);
      await ShellCommand({ command: 'echo recorded' }, chatState);
      expect(chatState.vars.lastShellCommand).toMatchObject({
        command: 'echo recorded',
        exitCode: 0,
        success: true,
      });
      expect(chatState.vars.lastShellCommand.lastExecuted).toBeInstanceOf(Date);
    });

    it('honours the timeout and flags the result as timed out', async () => {
      stubTemplateService(chatState);
      const result = await ShellCommand(
        { command: 'sleep 5', timeoutInSeconds: 1 },
        chatState
      );
      expect(result.success).toBe(true);
      expect(result.data?.timedOut).toBe(true);
    }, 20000);

    it('pipes massive stdout to a tmp file when exceeding threshold and updates response', async () => {
      stubTemplateService(chatState);
      const result = await ShellCommand(
        { command: 'seq 1 6000' },
        chatState
      );
      expect(result.success).toBe(true);
      expect(result.data?.outputTruncated).toBe(true);
      expect(result.data?.outputFile).toBeDefined();
      expect(typeof result.data?.outputFile).toBe('string');
      expect(require('fs').existsSync(result.data?.outputFile!)).toBe(true);

      const fileContent = require('fs').readFileSync(result.data?.outputFile!, 'utf8');
      expect(fileContent).toContain('6000');

      expect(result.data?.outputSize).toBeGreaterThan(20000);
      expect(result.data?.stdout).toContain('Output size');
      expect(result.data?.stdout).toContain('exceeds the maximum allowed output threshold');
      expect(result.data?.stdout).toContain(result.data?.outputFile);
      expect(result.data?.stdout).toContain('targeted search');

      expect(result.instructions).toContain('Output was piped to temporary file');
      expect(result.instructions).toContain(result.data?.outputFile);

      if (result.data?.outputFile && require('fs').existsSync(result.data.outputFile)) {
        require('fs').unlinkSync(result.data.outputFile);
      }
    });

    it('honours maxOutputSize parameter from props', async () => {
      stubTemplateService(chatState);
      const result = await ShellCommand(
        { command: 'seq 1 100', maxOutputSize: 100 },
        chatState
      );
      expect(result.success).toBe(true);
      expect(result.data?.outputTruncated).toBe(true);
      expect(result.data?.outputFile).toBeDefined();
      expect(result.data?.stdout).toContain('100');

      if (result.data?.outputFile && require('fs').existsSync(result.data.outputFile)) {
        require('fs').unlinkSync(result.data.outputFile);
      }
    });

    it('returns output inline when under maxOutputSize threshold', async () => {
      stubTemplateService(chatState);
      const result = await ShellCommand(
        { command: 'echo "small output"', maxOutputSize: 20000 },
        chatState
      );
      expect(result.success).toBe(true);
      expect(result.data?.outputTruncated).toBeUndefined();
      expect(result.data?.outputFile).toBeUndefined();
      expect(result.data?.stdout).toBe('small output');
    });
  });
});
