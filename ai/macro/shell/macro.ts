import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ChildProcess, SpawnOptions, exec, ExecOptions, spawn } from "child_process";
import fs, { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import Reactory from "@reactorynet/reactory-core";
import { ComponentDomain, FeatureType } from "@reactorynet/reactory-core";
import { ShellCommandArgs, ShellCommandMacroOutput } from "@reactory/server-modules/reactory-reactor/types/macro.types";
import { ShellCommandProps, ShellCommandResult } from './types';
import logger from "@reactory/server-core/logging";

const DEFAULT_SHELL_TEMPLATE = `
#!/bin/bash
# This is a default shell template
# You can create your own templates by creating a file in the <process.env.APP_DATA_ROOT>/templates/shell directory
# The file name should be the template id with a .sh.ejs extension
# Templates can be loaded into the database using the template service
echo "Reactory Shell running using default template"
<%- environmentVars%>
<%- command%>
`

const ERROR_SHELL_TEMPLATE = `
#!/bin/bash
echo "Warning! Unable to process template error: <%-error%>"
echo "Please check the template configuration and try again."
echo "Attempting to start a shell with the default template"
<%- environmentVars%>
<%- command%>
`
/**
 * A security check to prevent potentially dangerous shell commands from being executed.
 * @param command 
 * @param state 
 */
export const secureShell = (command: string, state: ChatState): void => {
  const dangerousCommandPatterns = [
    /^rm\s/,
    /^mv\s/,
    /^cp\s/,
    /^dd\s/,
    /^mkfs\s/,
    /^mke2fs\s/,
    /^mkswap\s/,
    /^useradd\s/,
    /^usermod\s/,
    /^userdel\s/,
    /^groupadd\s/,
    /^groupmod\s/,
    /^groupdel\s/,
    /^passwd\s/,
    /^chown\s/,
    /^chmod\s/,
    /^chgrp\s/,
    /^chroot\s/,
    /^mount\s/,
    /^umount\s/,
    /^kill\s/,
    /^pkill\s/,
    /^pgrep\s/,
    // Data exfiltration and remote execution vectors
    /^wget\s/,
    /^curl\s/,
    /^nc\s/,
    /^ncat\s/,
    /^netcat\s/,
    // Script interpreter direct execution (prevents arbitrary code execution)
    /^python[23]?\s+-c\s/,
    /^perl\s+-e\s/,
    /^ruby\s+-e\s/,
    /^node\s+-e\s/,
    /^bash\s+-c\s/,
    /^sh\s+-c\s/,
    /^zsh\s+-c\s/,
    // Process / system modification
    /^shutdown\s/,
    /^reboot\s/,
    /^init\s/,
    /^systemctl\s/,
    /^service\s/,
  ];

  //check if environment variable DENY_SHELL_EXECUTION is set to true
  if (process.env.DENY_SHELL_EXECUTION === 'true') {
    throw new Error('Unauthorized: Shell execution is disabled.');
  }

  const { context } = state;

  // Check if user is authenticated and has the necessary role
  if (!context || !context.hasAnyRole(['ADMIN', 'DEVELOPER', 'SHELL-EXEC'])) {
    throw new Error('Unauthorized: User does not have the necessary role to execute shell commands.');
  }

  // Check if environment varable DENIED_SHELL_COMMANDS is set
  if (process.env.DENIED_SHELL_COMMANDS) {
    const deniedCommands = process.env.DENIED_SHELL_COMMANDS.split(',');
    //add to the dangerous command patterns
    dangerousCommandPatterns.push(...deniedCommands.map(cmd => new RegExp(`^${cmd}\\s`)));
  }

  // Check if command matches any dangerous patterns
  dangerousCommandPatterns.forEach((pattern) => {
    if (pattern.test(command)) {
      throw new Error(`Security Alert: Attempted to execute a potentially dangerous command: ${command}`);
    }
  });
}

/**
 * Gets the shell command text using the given template id.
 * @param templateId 
 * @param command 
 * @param state 
 * @returns 
 */
const getShellCommandText = async (templateId: string, command: string, state: ChatState): Promise<string> => {

  const { context } = state;
  const templateSvc = context.getService<Reactory.Service.IReactoryTemplateService>('core.TemplateService@1.0.0');
  let shellCommandText = null;
  /** Whitelist of safe environment variables to expose to shell commands */
  const SAFE_ENV_VARS = [
    'PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TERM',
    'LC_ALL', 'LC_CTYPE', 'EDITOR', 'VISUAL',
    'APP_DATA_ROOT', 'NODE_ENV', 'REACTORY_SERVER',
    'REACTORY', 'REACTORY_CLIENT', 'REACTORY_CORE',
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
  }

  //first check if the template service is available
  //if it is we will try to get the template from the database
  if (templateSvc) {
    const templateDoc = await templateSvc.getTemplate(`shell/${templateId}.sh`, context.partner.id);
    if (templateDoc) {
      shellCommandText = await templateSvc.renderTemplate(templateDoc, {
        command,
        environmentVars: commandWithEnvVars,
        context: context,
        state: state,
        vars: state.vars,
        process: process,
      });
    }
  }

  //if we still don't have a template we will try to get the template from the file system
  if (shellCommandText === null) {
    shellCommandText = await templateSvc.renderTemplate(templateFromFile(), {
      command,
      environmentVars: commandWithEnvVars,
      context: context,
      state: state,
      vars: state.vars,
      process: process,
    });
  }

  if (!shellCommandText) {
    shellCommandText = await templateSvc.renderTemplate(ERROR_SHELL_TEMPLATE, {
      error: `No template found on file or in database: ${templateId}`,
      command,
      environmentVars: commandWithEnvVars,
      context: context,
      state: state,
      vars: state.vars,
      process: process,
    });
  }

  return shellCommandText;
}

/**
 * A macro that writes a shell command to a temporary .sh file and executes it.
 * @param props - ShellCommandProps - { command, workingDir, templateId, timeoutInSeconds, sudo, format, shell }
 * @param state - the current chat state
 * @returns the result of the shell command
 */
export const ShellCommand: Macro<ShellCommandResult, ShellCommandProps> = async (props: ShellCommandProps, state: ChatState): Promise<ShellCommandResult> => {
  const startTime = Date.now();
  const {
    command: shellCommand,
    workingDir = process.cwd(),
    templateId = 'default',
    timeoutInSeconds = 60,
    sudo = 'false',
    format = 'string',
    shell = '/bin/bash'
  } = props;

  if (!shellCommand || shellCommand.trim().length === 0) {
    return {
      success: false,
      error: 'No command provided',
      tool: 'shell',
      params: props
    };
  }

  try {
    // Check if command is potentially dangerous
    secureShell(shellCommand, state);
  } catch (securityError) {
    return {
      success: false,
      error: `Security Check Failed: ${securityError.message}`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }

  // Validate working directory
  if (!fs.existsSync(workingDir)) {
    return {
      success: false,
      error: `Working directory "${workingDir}" does not exist.`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }

  const shFilePath = path.join(os.tmpdir(), `${templateId}.sh`);
  let shellCommandText = null;

  // Get shell command text
  try {
    shellCommandText = await getShellCommandText(templateId, shellCommand, state);
  } catch (error) {
    logger.error(`Error getting shell command text: ${error.message}`);
    return {
      success: false,
      error: `Error getting shell command text: ${error.message}`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }

  // Write shell command to file
  try {
    fs.writeFileSync(shFilePath, shellCommandText, { encoding: 'utf8' });
  } catch (fsError) {
    logger.error(`Error writing shell command to file: ${fsError.message}`);
    return {
      success: false,
      error: `Error writing shell command to file: ${fsError.message}`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }

  // Make the file executable
  try {
    fs.chmodSync(shFilePath, 0o700);
  } catch (fsError) {
    logger.error(`Error setting file permissions: ${fsError.message}`);
    return {
      success: false,
      error: `Error setting file permissions: ${fsError.message}`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }

  const removeTmpFile = () => {
    if (fs.existsSync(shFilePath)) fs.unlinkSync(shFilePath);
  };

  // Execute .sh file
  const execCommand = async (command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    pid?: number;
    executionTime: number;
  }> => {
    return new Promise((resolve, reject) => {
      const execOptions: ExecOptions = {
        cwd: workingDir,
        shell
      };

      let childProcess: ChildProcess = null;
      let timer: NodeJS.Timeout;
      const shellOut: string[] = [];
      const shellErr: string[] = [];
      const commandStartTime = Date.now();
      let timedOut = false;
      let exitCode = 0;

      const cleanExit = () => {
        clearTimeout(timer);
        if (childProcess) childProcess.removeAllListeners();
        removeTmpFile();
        const errorString = shellErr.join('\n').trim();
        const outString = shellOut.join('\n').trim();
        const executionTime = Date.now() - commandStartTime;
        
        resolve({
          stdout: outString,
          stderr: errorString,
          exitCode,
          timedOut,
          pid: childProcess?.pid,
          executionTime
        });
      }

      try {
        childProcess = spawn(command, [], execOptions);
        timer = setTimeout(() => {
          timedOut = true;
          shellErr.push(`Process timed out after ${timeoutInSeconds} seconds`);
          if (childProcess) {
            childProcess.kill('SIGTERM');
          } else {
            cleanExit();
          }
        }, Number(timeoutInSeconds) * 1000);

        const exitHandler = (code: number, signal: string) => {
          exitCode = code || 0;
          if (code !== 0) shellErr.push(`error: ${code} - ${signal}`);
          cleanExit();
        }

        childProcess.stdout.on('data', (data) => {
          shellOut.push(typeof data?.toString === 'function' ? data.toString() : data);
        });

        childProcess.stderr.on('data', (data) => {
          // Use a basic regex to check if the data is an error message
          const regex = /failed|failure|error|crash/i;
          const stringData = typeof data?.toString === 'function' ? data.toString() : data;
          if (regex.test(stringData)) { 
            shellErr.push(stringData);
            return;
          } 
          shellOut.push(stringData);
        });

        ["close", "exit", "error", "disconnect"].forEach((evt) => childProcess.on(evt, exitHandler));
      } catch (err) {
        shellErr.push(err.message);
        cleanExit();
      }
    });
  };

  try {
    const result = await execCommand(`${sudo !== 'false' ? 'sudo ' : ''}${shFilePath}`);
    const totalExecutionTime = Date.now() - startTime;
    const commandSuccess = result.exitCode === 0 && !result.timedOut;
    const output = `${result.stdout}${result.stderr}`.trim();

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastShellCommand = {
      command: shellCommand,
      workingDir,
      shell,
      templateId,
      sudo: sudo === 'true',
      exitCode: result.exitCode,
      success: commandSuccess,
      executionTime: result.executionTime,
      timedOut: result.timedOut,
      lastExecuted: new Date()
    };

    // Log execution for security
    logger.info(`ShellCommand macro executed: ${shellCommand} by user: ${state.user?.id || 'unknown'}, exitCode: ${result.exitCode}, timedOut: ${result.timedOut}`);

    return {
      success: true,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        output,
        exitCode: result.exitCode,
        success: commandSuccess,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true',
        executionTime: result.executionTime,
        timedOut: result.timedOut,
        pid: result.pid
      },
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true',
        exitCode: result.exitCode,
        timedOut: result.timedOut
      },
      instructions: `
## Shell Command Results

Successfully executed shell command: **${shellCommand}**

### Execution Information:
- **Command**: ${shellCommand}
- **Working Directory**: ${workingDir}
- **Shell**: ${shell}
- **Template**: ${templateId}
- **Sudo**: ${sudo === 'true' ? 'Yes' : 'No'}
- **Exit Code**: ${result.exitCode}
- **Success**: ${commandSuccess ? 'Yes' : 'No'}
- **Timed Out**: ${result.timedOut ? 'Yes' : 'No'}
- **Execution Time**: ${result.executionTime}ms
- **Total Time**: ${totalExecutionTime}ms
- **Process ID**: ${result.pid || 'N/A'}

### Available Data:
- **stdout**: Standard output from the command
- **stderr**: Standard error output from the command
- **output**: Combined output (stdout + stderr)
- **exitCode**: Exit code of the command (0 = success)
- **success**: Whether the command completed successfully
- **executionTime**: Time taken for command execution
- **timedOut**: Whether the command timed out

### State Variables Available:
- lastShellCommand: Complete command information for future reference

### Usage:
- Use \`stdout\` for successful command output
- Use \`stderr\` for error messages and warnings
- Use \`output\` for combined output analysis
- Use \`exitCode\` to determine command success (0 = success)
- Use \`success\` for boolean success status
- Use \`data\` for comprehensive command information
      `
    };

  } catch (error) {
    const totalExecutionTime = Date.now() - startTime;
    logger.error(`Command execution failed: ${error.message}`);
    
    return {
      success: false,
      error: `Command execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'shell',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        command: shellCommand,
        workingDir,
        shell,
        templateId,
        sudo: sudo === 'true'
      }
    };
  }
};

const ShellCommandComponentRegister: MacroComponentDefinition<typeof ShellCommand> = {
  nameSpace: 'reactor-macros',
  name: 'shell',
  version: '1.0.0',
  component: ShellCommand,
  description: 'Executes a shell command with structured results and comprehensive metadata',
  features: [{
    feature: 'shell',
    description: 'Executes a shell command with structured results and metadata',
    featureType: FeatureType.function,
    action: ["execute", "run", "shell", "command"],
    stem: "shell",
  }],
  tags: ['shell', 'command', 'execute', 'run', 'script', 'sh'],
  domain: ComponentDomain.function,
  roles: ['ADMIN','SHELL-EXEC', 'DEVELOPER'],
  stem: 'shell',
  tools: [{
    type: "function",
    function: {
      name: "shell",
      icon: "handyman",
      description: "Executes a shell command with structured results and comprehensive metadata",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute"
          },
          workingDir: {
            type: "string",
            description: "The working directory for the shell command"
          },
          templateId: {
            type: "string",
            description: "The template id to use for the shell command"
          },
          timeoutInSeconds: {
            type: "number",
            description: "The timeout in seconds for the shell command (default: 60)"
          },
          sudo: {
            type: "string",
            enum: ["true", "false"],
            description: "Use sudo to execute the shell command"
          },
          format: {
            type: "string",
            enum: ["string", "object"],
            description: "The format of the output (string or object)"
          },
          shell: {
            type: "string",
            enum: ["/bin/bash", "/bin/zsh"],
            description: "The shell to use for the command"
          }
        },
        required: ["command"]
      }
    }
  }]
};

export default ShellCommandComponentRegister
