import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ChildProcess, ExecOptions, spawn } from "child_process";
import { ObjectId } from "mongodb";
import fs from 'fs';
import os from 'os';
import path from 'path';
import Reactory from "@reactorynet/reactory-core";
import { ComponentDomain, FeatureType } from "@reactorynet/reactory-core";
import { ShellCommandProps, ShellCommandResult } from './types';
import logger from "@reactory/server-core/logging";
import { ShellStreamPublisher } from "@reactory/server-modules/reactory-reactor/services/reactor/streaming/ShellStreamPublisher";

const DEFAULT_SHELL_TEMPLATE = `
<%- environmentVars%>
<%- command%>
`

const ERROR_SHELL_TEMPLATE = `
<%- environmentVars%>
<%- command%>
`

/**
 * A security check to prevent potentially dangerous shell commands from being executed.
 */
export const secureShell = (command: string, state: ChatState): void => {
  const dangerousCommandPatterns = [
    /^rm\s/, /^mv\s/, /^cp\s/, /^dd\s/, /^mkfs\s/, /^mke2fs\s/, /^mkswap\s/,
    /^useradd\s/, /^usermod\s/, /^userdel\s/, /^groupadd\s/, /^groupmod\s/, /^groupdel\s/,
    /^passwd\s/, /^chown\s/, /^chmod\s/, /^chgrp\s/, /^chroot\s/, /^mount\s/, /^umount\s/,
    /^kill\s/, /^pkill\s/, /^pgrep\s/,
    /^wget\s/, /^curl\s/, /^nc\s/, /^ncat\s/, /^netcat\s/,
    /^python[23]?\s+-c\s/, /^perl\s+-e\s/, /^ruby\s+-e\s/,
    /^node\s+-e\s/, /^bash\s+-c\s/, /^sh\s+-c\s/, /^zsh\s+-c\s/,
    /^shutdown\s/, /^reboot\s/, /^init\s/, /^systemctl\s/, /^service\s/,
  ];

  if (process.env.DENY_SHELL_EXECUTION === 'true') {
    throw new Error('Unauthorized: Shell execution is disabled.');
  }

  const { context } = state;
  if (!context || !context.hasAnyRole(['ADMIN', 'DEVELOPER', 'SHELL-EXEC'])) {
    throw new Error('Unauthorized: User does not have the necessary role to execute shell commands.');
  }

  if (process.env.DENIED_SHELL_COMMANDS) {
    const deniedCommands = process.env.DENIED_SHELL_COMMANDS.split(',');
    dangerousCommandPatterns.push(...deniedCommands.map(cmd => new RegExp(`^${cmd}\\s`)));
  }

  dangerousCommandPatterns.forEach((pattern) => {
    if (pattern.test(command)) {
      throw new Error(`Security Alert: Attempted to execute a potentially dangerous command: ${command}`);
    }
  });
};

/**
 * Gets the shell command text using the given template id.
 */
const getShellCommandText = async (templateId: string, command: string, state: ChatState): Promise<string> => {
  const { context } = state;
  const templateSvc = context.getService<Reactory.Service.IReactoryTemplateService>('core.TemplateService@1.0.0');
  let shellCommandText = null;

  const SAFE_ENV_VARS = [
    'PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TERM',
    'LC_ALL', 'LC_CTYPE', 'EDITOR', 'VISUAL',
    'APP_DATA_ROOT', 'NODE_ENV', 'REACTORY_SERVER',
    'REACTORY', 'REACTORY_CLIENT', 'REACTORY_CORE', 'REACTORY_DATA', 'REACTORY_HOME'
  ];
  const commandWithEnvVars = `${Object.entries(process.env)
    .filter(([key]) => SAFE_ENV_VARS.includes(key))
    .map(([key, val]) => `export ${key}='${val}'`)
    .join('\n')}`;

  const templateFromFile = (): string => {
    if (!fs.existsSync(path.join(process.env.APP_DATA_ROOT, 'templates/shell'))) {
      fs.mkdirSync(path.join(process.env.APP_DATA_ROOT, 'templates/shell'), { recursive: true });
      fs.writeFileSync(path.join(process.env.APP_DATA_ROOT, DEFAULT_SHELL_TEMPLATE, 'default.sh.ejs'), '');
      return DEFAULT_SHELL_TEMPLATE;
    }
    const templatePath = path.join(process.env.APP_DATA_ROOT, 'templates/shell', `${templateId}.sh.ejs`);
    if (!fs.existsSync(templatePath)) {
      return DEFAULT_SHELL_TEMPLATE;
    }
    return fs.readFileSync(templatePath, 'utf8');
  };

  if (templateSvc) {
    const templateDoc = await templateSvc.getTemplate(`shell/${templateId}.sh`, context.partner.id);
    if (templateDoc) {
      shellCommandText = await templateSvc.renderTemplate(templateDoc, {
        command, environmentVars: commandWithEnvVars,
        context, state, vars: state.vars, process,
      });
    }
  }

  if (shellCommandText === null) {
    shellCommandText = await templateSvc.renderTemplate(templateFromFile(), {
      command, environmentVars: commandWithEnvVars,
      context, state, vars: state.vars, process,
    });
  }

  if (!shellCommandText) {
    shellCommandText = await templateSvc.renderTemplate(ERROR_SHELL_TEMPLATE, {
      error: `No template found on file or in database: ${templateId}`,
      command, environmentVars: commandWithEnvVars,
      context, state, vars: state.vars, process,
    });
  }

  return shellCommandText;
};

/**
 * A macro that writes a shell command to a temporary .sh file and executes it.
 */
export const ShellCommand: Macro<ShellCommandResult, ShellCommandProps> = async (props: ShellCommandProps, state: ChatState, context?: Reactory.Server.IReactoryContext): Promise<ShellCommandResult> => {
  const startTime = Date.now();
  const {
    command: shellCommand,
    workingDir = process.cwd(),
    templateId = 'default',
    timeoutInSeconds = 60,
    sudo = 'false',
    format = 'string',
    shell = '/bin/bash',
    maxOutputSize: propsMaxOutputSize
  } = props;

  const maxOutputSize = typeof propsMaxOutputSize === 'number' && propsMaxOutputSize > 0
    ? propsMaxOutputSize
    : (process.env.SHELL_MAX_OUTPUT_SIZE ? parseInt(process.env.SHELL_MAX_OUTPUT_SIZE, 10) : 20000);

  // Unique terminal id for this one-shot invocation. Streamed to the client so
  // the shell widget can render this command's output as its own terminal pane
  // and correlate it with the final tool-call result.
  const shellSessionId = new ObjectId().toString();
  // The macro receives `context` only when run through the conversation service
  // AUTO loop; on the CLI / tool-only path it is undefined and streaming no-ops.
  const publisher = ShellStreamPublisher.fromContext(context ?? (state as any)?.context, {
    channelId: (state as any)?.id ? String((state as any).id) : '',
    shellSessionId,
    source: 'macro',
    messageId: (state as any)?.vars?.currentMessageId,
  });

  if (!shellCommand || shellCommand.trim().length === 0) {
    return {
      success: false, error: 'No command provided',
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  try {
    secureShell(shellCommand, state);
  } catch (securityError) {
    return {
      success: false, error: `Security Check Failed: ${securityError.message}`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  if (!fs.existsSync(workingDir)) {
    return {
      success: false, error: `Working directory "${workingDir}" does not exist.`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  // The script path must be unique per invocation. It used to be
  // `<tmpdir>/<templateId>.sh`, a fixed name shared by every concurrent call —
  // so two shell macros running at once (two users, or two Jest workers) would
  // overwrite each other's script, and whichever finished first deleted the
  // file the other was about to execute. shellSessionId is already unique for
  // this invocation, so reuse it.
  const shFilePath = path.join(os.tmpdir(), `${templateId}-${shellSessionId}.sh`);
  let shellCommandText = null;

  try {
    shellCommandText = await getShellCommandText(templateId, shellCommand, state);
  } catch (error: any) {
    logger.error(`Error getting shell command text: ${error.message}`);
    return {
      success: false, error: `Error getting shell command text: ${error.message}`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  try {
    fs.writeFileSync(shFilePath, shellCommandText, { encoding: 'utf8' });
  } catch (fsError: any) {
    logger.error(`Error writing shell command to file: ${fsError.message}`);
    return {
      success: false, error: `Error writing shell command to file: ${fsError.message}`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  try {
    fs.chmodSync(shFilePath, 0o700);
  } catch (fsError: any) {
    logger.error(`Error setting file permissions: ${fsError.message}`);
    return {
      success: false, error: `Error setting file permissions: ${fsError.message}`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }

  const removeTmpFile = () => {
    if (fs.existsSync(shFilePath)) fs.unlinkSync(shFilePath);
  };

  const execCommand = async (command: string): Promise<{
    stdout: string; stderr: string; exitCode: number; timedOut: boolean; pid?: number; executionTime: number;
  }> => {
    return new Promise((resolve, reject) => {
      const execOptions: ExecOptions = { cwd: workingDir, shell };
      let childProcess: ChildProcess = null;
      let timer: NodeJS.Timeout;
      const shellOut: string[] = [];
      const shellErr: string[] = [];
      const commandStartTime = Date.now();
      let timedOut = false;
      let exitCode = 0;

      let exitEmitted = false;
      const cleanExit = () => {
        clearTimeout(timer);
        if (childProcess) childProcess.removeAllListeners();
        removeTmpFile();
        if (!exitEmitted) { exitEmitted = true; publisher.exit(exitCode, timedOut); }
        resolve({ stdout: shellOut.join('\n').trim(), stderr: shellErr.join('\n').trim(), exitCode, timedOut, pid: childProcess?.pid, executionTime: Date.now() - commandStartTime });
      };

      try {
        childProcess = spawn(command, [], execOptions);
        publisher.start(shellCommand, workingDir, childProcess?.pid);
        timer = setTimeout(() => { timedOut = true; shellErr.push(`Process timed out after ${timeoutInSeconds} seconds`); childProcess?.kill('SIGTERM'); cleanExit(); }, Number(timeoutInSeconds) * 1000);

        const exitHandler = (code: number, signal: string) => {
          exitCode = code || 0;
          if (code !== 0) shellErr.push(`error: ${code} - ${signal}`);
          cleanExit();
        };

        childProcess.stdout.on('data', (data) => {
          const stringData = typeof data?.toString === 'function' ? data.toString() : data;
          shellOut.push(stringData);
          publisher.stdout(stringData);
        });
        childProcess.stderr.on('data', (data) => {
          const stringData = typeof data?.toString === 'function' ? data.toString() : data;
          if (/failed|failure|error|crash/i.test(stringData)) { shellErr.push(stringData); publisher.stderr(stringData); return; }
          shellOut.push(stringData);
          publisher.stdout(stringData);
        });
        ["close", "exit", "error", "disconnect"].forEach((evt) => childProcess.on(evt, exitHandler));
      } catch (err: any) {
        shellErr.push(err.message);
        cleanExit();
      }
    });
  };

  try {
    const result = await execCommand(`${sudo !== 'false' ? 'sudo ' : ''}${shFilePath}`);
    const totalExecutionTime = Date.now() - startTime;
    const commandSuccess = result.exitCode === 0 && !result.timedOut;

    let finalStdout = result.stdout;
    let outputFile: string | undefined = undefined;
    let outputSize: number | undefined = undefined;
    let outputTruncated: boolean | undefined = undefined;
    let instructions: string | undefined = undefined;

    if (result.stdout && result.stdout.length > maxOutputSize) {
      outputFile = path.join(os.tmpdir(), `shell-output-${shellSessionId}.log`);
      outputSize = Buffer.byteLength(result.stdout, 'utf8');
      outputTruncated = true;
      try {
        fs.writeFileSync(outputFile, result.stdout, { encoding: 'utf8' });
      } catch (writeErr: any) {
        logger.error(`Error writing shell stdout to tmp file ${outputFile}: ${writeErr.message}`);
      }

      finalStdout = `Output size (${outputSize} bytes / ${result.stdout.length} characters) exceeds the maximum allowed output threshold (${maxOutputSize} characters). The complete output has been piped to a temporary file: ${outputFile}. Please use targeted search (such as snip, grep, or searchContent) to inspect relevant sections of the output file, or issue a new shell command with filters to reduce the output volume.`;
      instructions = `Output was piped to temporary file: ${outputFile} (size: ${outputSize} bytes). Use targeted search tools (such as snip, grep, or searchContent) to read specific sections, or issue a new shell command to reduce output.`;
    }

    if (!state.vars) state.vars = {};
    state.vars.lastShellCommand = {
      command: shellCommand, workingDir, shell, templateId,
      sudo: sudo === 'true', exitCode: result.exitCode, success: commandSuccess,
      executionTime: result.executionTime, timedOut: result.timedOut, lastExecuted: new Date()
    };

    logger.info(`ShellCommand: ${shellCommand}, exitCode: ${result.exitCode}, timedOut: ${result.timedOut}`);

    return {
      success: true,
      data: {
        stdout: finalStdout,
        stderr: result.stderr,
        exitCode: result.exitCode, success: commandSuccess,
        command: shellCommand, workingDir, shell, templateId,
        sudo: sudo === 'true', executionTime: result.executionTime, timedOut: result.timedOut, pid: result.pid,
        shellSessionId,
        ...(outputFile ? { outputFile, outputSize, outputTruncated } : {})
      },
      tool: 'shell', params: props,
      metadata: { executionTime: totalExecutionTime, timestamp: new Date() },
      ...(instructions ? { instructions } : {})
    };
  } catch (error: any) {
    logger.error(`Command execution failed: ${error.message}`);
    return {
      success: false,
      error: `Command execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'shell', params: props,
      metadata: { executionTime: Date.now() - startTime, timestamp: new Date() }
    };
  }
};

const ShellCommandComponentRegister: MacroComponentDefinition<typeof ShellCommand> = {
  nameSpace: 'reactor-macros', name: 'shell', version: '1.0.0', component: ShellCommand,
  description: 'Executes a shell command with structured results and comprehensive metadata',
  features: [{ feature: 'shell', description: 'Executes a shell command with structured results and metadata', featureType: FeatureType.function, action: ["execute", "run", "shell", "command"], stem: "shell" }],
  tags: ['shell', 'command', 'execute', 'run', 'script', 'sh'],
  domain: ComponentDomain.function,
  roles: ['ADMIN', 'SHELL-EXEC', 'DEVELOPER'],
  stem: 'shell',
  tools: [{
    type: "function",
    function: {
      name: "shell", icon: "handyman", description: "Executes a shell command with structured results and comprehensive metadata",
      parameters: {
        type: "object", properties: {
          command: { type: "string", description: "The shell command to execute" },
          workingDir: { type: "string", description: "The working directory for the shell command" },
          templateId: { type: "string", description: "The template id to use for the shell command" },
          timeoutInSeconds: { type: "number", description: "The timeout in seconds for the shell command (default: 60)" },
          sudo: { type: "string", enum: ["true", "false"], description: "Use sudo to execute the shell command" },
          format: { type: "string", enum: ["string", "object"], description: "The format of the output (string or object)" },
          shell: { type: "string", enum: ["/bin/bash", "/bin/zsh"], description: "The shell to use for the command" },
          maxOutputSize: { type: "number", description: "Maximum output character threshold before piping stdout to a tmp file (default: 20000)" }
        }, required: ["command"]
      }
    }
  }]
};

export default ShellCommandComponentRegister
