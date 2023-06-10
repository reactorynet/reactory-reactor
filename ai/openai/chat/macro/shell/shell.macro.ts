import { ChatState, Macro } from "modules/reactor/types/chat.types";
import { exec } from "child_process";
import fs, { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import Reactory from "@reactory/reactory-core";
import { ComponentDomain, FeatureType } from "@reactory/reactory-core";
import { ShellCommandArgs, ShellCommandMacroOutput } from "modules/reactor/types/macro.types";
import ReactoryFormEditor from "modules/core/forms/ReactoryFormEditor";

const DEFAULT_SHELL_TEMPLATE = `
#!/bin/bash
# This is a default shell template
# You can create your own templates by creating a file in the <process.env.APP_DATA_ROOT>/templates/shell directory
# The file name should be the template id with a .sh.ejs extension
# Templates can be loaded into the database using the template service
echo "Reactory Shell running using default template"
<%=environmentVars%>
<%=command%>
`

const ERROR_SHELL_TEMPLATE = `
#!/bin/bash

<%=environmentVars%>
echo "Warning! Unable to process template error: <%=error%>"
echo "Please check the template configuration and try again."
echo "Attempting to start a shell with the default template"
<%=command%>
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
  ];

  //check if environment variable DENY_SHELL_EXECUTION is set to true
  if (process.env.DENY_SHELL_EXECUTION === 'true') {
    throw new Error('Unauthorized: Shell execution is disabled.');
  }

  const { context } = state;

  // Check if user is authenticated and has the necessary role
  if (!context || !context.hasRole('SHELL-EXEC') && !context.hasRole('ADMIN')) {
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
    });
  }

  if (!shellCommandText) {
    shellCommandText = await templateSvc.renderTemplate(ERROR_SHELL_TEMPLATE, {
      error: `No template found on file or in database: ${templateId}`,
      command,
      environmentVars: commandWithEnvVars,
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
    format ='string'
  ] = args;

  try {
    // Check if command is potentially dangerous
    secureShell(shellCommand, state);
  } catch (securityError) {
    return `Security Check Failed: ${securityError.message}`
  }

  // Validate working directory
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Working directory "${workingDir}" does not exist.`);
  }

  // Create .sh file
  const shFilePath = path.join(os.tmpdir(), `${templateId}.sh`);
  fs.writeFileSync(shFilePath, getShellCommandText(templateId, shellCommand, state));
  //make the file executable
  fs.chmodSync(shFilePath, 0o777);

  // Execute .sh file
  const execCommand = (command: string): Promise<ShellCommandMacroOutput> => {
    return new Promise((resolve, reject) => {
      const child = exec(command, { cwd: workingDir }, (error, stdout, stderr) => {
        if (error) {
          reject(format === 'string' ? `Error: ${error.message}` : { stdout, stderr });
        } else if (stderr) {
          reject(format === 'string' ? `Stderr: ${stderr}` : { stdout, stderr });
        } else {
          resolve(format === 'string' ? stdout : { stderr: stderr, stdout });
        }
      });

      if (timeoutInSeconds) {
        const timeoutInMilliseconds = parseInt(timeoutInSeconds, 10) * 1000;
        setTimeout(() => {
          child.kill(); // kills the process if it's still running after the timeout
          reject(`Command execution timed out after ${timeoutInSeconds} seconds.`);
        }, timeoutInMilliseconds);
      }
    });
  };


  // check if a command is provided
  if (shellCommand && shellCommand.length > 0) {
    try {
      const result = await execCommand(`${sudo !== 'false' ? 'sudo ' : ''}sh ${shFilePath}`);
      return result;
    } catch (error) {
      return format === 'string' ? `Command execution failed: ${error}` : { stderr: error?.message || error, stdout: null };
    }
  } else {
    return  format === 'string' ? 'No command provided': { stderr: 'No command provided', stdout: null };
  }
};

const ShellCommandComponentRegister: Reactory.IReactoryComponentDefinition<typeof ShellCommand> = { 
  nameSpace: 'reactor',
  name: 'ShellCommand',
  version: '1.0.0',
  component: ShellCommand,
  description: readFileSync(require.resolve('./shell.macro.md')).toString(),
  features: [{
    feature: 'shell',
    description: 'Executes a shell command',
    featureType: FeatureType.function,
    action: ["execute", "run", "shell", "command"],
    stem: "shell",
  }],
  tags: ['shell', 'command', 'execute', 'run', 'script', 'sh'],
  domain: ComponentDomain.function,
  roles: ['SHELL-EXEC'],
  stem: 'shell',
};

export default ShellCommandComponentRegister
