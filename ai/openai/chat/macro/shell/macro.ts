import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ChildProcess, SpawnOptions, exec, ExecOptions, spawn } from "child_process";
import fs, { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import Reactory from "@reactory/reactory-core";
import { ComponentDomain, FeatureType } from "@reactory/reactory-core";
import { ShellCommandArgs, ShellCommandMacroOutput } from "@reactory/server-modules/reactory-reactor/types/macro.types";
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
    /^mkfs\s/,
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
  const commandWithEnvVars = `${Object.entries(process.env).map(([key, val]) => `export ${key}='${val}'`).join('\n')}`;

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
 * @param args - a list of arguments for the shell command
 * @param state - the current chat state
 * @param context - the current reactory context
 * @returns the result of the shell command
 */
export const ShellCommand: Macro<ShellCommandMacroOutput> = async (args: ShellCommandArgs, state: ChatState): Promise<ShellCommandMacroOutput> => {

  const [
    shellCommand,
    workingDir = process.cwd(),
    templateId = 'default',
    timeoutInSeconds = '60',
    sudo = 'false',
    format = 'string',
    shell = '/bin/bash'

  ] = args;

  try {
    // Check if command is potentially dangerous
    secureShell(shellCommand, state);
  } catch (securityError) {
    return format === 'string' ?  
      `Security Check Failed: ${securityError.message}` :
      { stderr: `Security Check Failed: ${securityError.message}`, stdout: null };
  }

  // Validate working directory
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Working directory "${workingDir}" does not exist.`);
  }

  const shFilePath = path.join(os.tmpdir(), `${templateId}.sh`);
  let shellCommandText = null;

  //handle each process with each own try catch block in order 
  //to provide more detailed error messages

  // Get shell command text
  try {
    shellCommandText = await getShellCommandText(templateId, shellCommand, state);
  } catch (error) {
    logger.error(`Error getting shell command text: ${error.message}`);
    return format === 'string' ? `Error getting shell command text: ${error.message}` : { stderr: `Error getting shell command text: ${error.message}`, stdout: null };
  }

  // Write shell command to file
  try {
    fs.writeFileSync(shFilePath, shellCommandText, { encoding: 'utf8' });
  } catch (fsError) {
    logger.error(`Error writing shell command to file: ${fsError.message}`);
    return format === 'string' ? `Error writing shell command to file: ${fsError.message}` : { stderr: `Error writing shell command to file: ${fsError.message}`, stdout: null };
  }


  //Make the file executable
  try {
    fs.chmodSync(shFilePath, 0o777);
  } catch (fsError) {
    logger.error(`Error setting file permissions: ${fsError.message}`);
    return format === 'string' ? `Error setting file permissions: ${fsError.message}` : { stderr: `Error setting file permissions: ${fsError.message}`, stdout: null };
  }

  const removeTmpFile = () => {
    if (fs.existsSync(shFilePath)) fs.unlinkSync(shFilePath);
  };

  // Execute .sh file
  const execCommand = async (command: string): Promise<ShellCommandMacroOutput> => {
    return new Promise((resolve, reject) => {
      const execOptions: ExecOptions = {
        cwd: workingDir,
        shell
      };

      let childProcess: ChildProcess = null;
      let timer: NodeJS.Timeout;
      const shellOut: string[] = [];
      const shellErr: string[] = [];

      const cleanExit = () => {
        clearTimeout(timer);
        if (childProcess) childProcess.removeAllListeners(); // removes all listeners from the child process
        removeTmpFile();
        const errorString = shellErr.join('\n').trim();
        const outString = shellOut.join('\n').trim();
        if (shellErr.length > 0) {
          reject(format === 'string' ? 
            `${outString}${errorString}` : 
            { stderr: errorString, stdout: outString });
        } else {
          resolve(format === 'string' ? 
          `${outString}${errorString}` : 
          { stderr: errorString, stdout: outString });
        }
      }

      try {
        childProcess = spawn(command, [], execOptions);
        timer = setTimeout(() => {
          shellErr.push(`Process timed out after ${timeoutInSeconds} seconds`)
          if (childProcess) {
            childProcess.kill('SIGTERM'); //exit will be handled by event.s
          } else {
            cleanExit();
          }

        }, parseInt(timeoutInSeconds, 10) * 1000);

        const exitHandler = (code: number, signal: string) => {
          if (code !== 0) shellErr.push(`error: ${code} - ${signal}`)
          cleanExit();
        }

        childProcess.stdout.on('data', (data) => {
          shellOut.push(typeof data?.toString === 'function' ? data.toString() : data );
        });

        childProcess.stderr.on('data', (data) => {
          //we use a basic regex to check if the data is a error message
          //message. If it is we will push it to the shellErr array 
          //otherwise we will push it to the shellOut array
          //unix systems use stderr to output messages that are not strictly errors
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
        shellErr.push(err.message)
        cleanExit();
      }
    })
  };

  if (shellCommand && shellCommand.length > 0) {
    try {
      const result = await execCommand(`${sudo !== 'false' ? 'sudo ' : ''}${shFilePath}`);
      return result;
    } catch (error) {
      logger.error(`Command execution failed: ${error.message}`);
      return format === 'string' ? `Command execution failed: ${error}` : { stderr: error?.message || error, stdout: null };
    }
  } else {
    return format === 'string' ? 'No command provided' : { stderr: 'No command provided', stdout: null };
  }
};

const ShellCommandComponentRegister: MacroComponentDefinition<typeof ShellCommand> = {
  nameSpace: 'reactor-macros',
  name: 'shell',
  version: '1.0.0',
  component: ShellCommand,
  description: readFileSync(require.resolve('./readme.md')).toString(),
  features: [{
    feature: 'shell',
    description: 'Executes a shell command',
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
      description: "Executes a shell command",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: `The arguments for the shell command:
            1. command: The shell command to execute
            2. workingDir: The working directory for the shell command
            3. templateId: The template id to use for the shell command
            4. timeoutInSeconds: The timeout in seconds for the shell command
            5. sudo: Use sudo to execute the shell command
            6. format: The format of the output (string or object)
            7. shell: The shell to use for the command`,
            items: {
              type: "string",            
            }
          },          
        },
        required: ["args"],
      }
    }
  }]
};

export default ShellCommandComponentRegister
