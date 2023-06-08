import { ChatState, Macro } from "modules/reactor/types/chat.types";
import { exec } from "child_process";
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_SHELL_TEMPLATE = `
#!/bin/bash
# This is a default shell template
# You can change this template by setting the environment variable DEFAULT_SHELL_TEMPLATE
<%=command%>
`

const ERROR_SHELL_TEMPLATE = `
#!/bin/bash

echo "Unabled to process tempalte Error: <%=error%>"
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
  if(process.env.DENY_SHELL_EXECUTION === 'true') {
    throw new Error('Unauthorized: Shell execution is disabled.');
  }

  const { context } = state;

  // Check if user is authenticated and has the necessary role
  if (!context || !context.hasRole('SHELL-EXEC') && !context.hasRole('ADMIN')) {
    throw new Error('Unauthorized: User does not have the necessary role to execute shell commands.');
  }

  // Check if environment varable DENIED_SHELL_COMMANDS is set
  if(process.env.DENIED_SHELL_COMMANDS) {
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

  if (shellCommandText === null) {
    shellCommandText = await templateSvc.renderTemplate(templateFromFile(), {
      command,
      environmentVars: commandWithEnvVars,
      context: context,
      state: state,
    });
  }

  if (!shellCommandText) {
    shellCommandText = await templateSvc.renderTemplate(ERROR_SHELL_TEMPLATE, { error: `Could not render template ${templateId}` });
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
export const ShellCommand: Macro<string> = async (args: any[], state: ChatState) => {

  const [
    shellCommand, 
    workingDir = process.cwd(), 
    templateId = 'default', 
    timeoutInSeconds = '60',
    sudo = 'false'
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
  const execCommand = (command: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const child = exec(command, { cwd: workingDir }, (error, stdout, stderr) => {
        if (error) {
          reject(`Error: ${error.message}`);
        } else if (stderr) {
          reject(`Stderr: ${stderr}`);
        } else {
          resolve(stdout);
        }
      });

      if (timeoutInSeconds) {
        const timeoutInMilliseconds = timeoutInSeconds * 1000;
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
      return `Command execution failed: ${error}`;
    }
  } else {
    return 'No command provided';
  }
};


/**
 * A macro that lists all services registered in the system or
 * returns the service with the given name / fqn.
 * @param args - a list of arguments for the service register macro
 * @param state - the current chat state
 * @param context - the current reactory context
 * @returns 
 */
export const ServiceRegister: Macro<string | object | object[]> = async (args: any[], state: ChatState, context?: Reactory.Server.IReactoryContext) => {
  
  const list = (format: string = 'string'): string | object => {
    const { services } = context;
    if(services && services.length > 0) {
      if(format === 'string') {
        return services.map(s => `${s.name}@${s.version}`).join('\n');
      } else {
        return services;
      }
    } else {
      return 'No services registered';
    }
  }

  if(args && args.length > 0) {
    switch(args[0]) {
      case 'list': {
        return list(args[1] || 'string');
        break;
      }
      case 'get': { 
        const [ , name, nameSpace, version, props = null, func = null, funcParams ] = args;
        const service = context?.getService<any>(`${nameSpace}.${name}@${version}`, props);
        if(service) {
          if(func && funcParams) { 
            const result = await service[func](...funcParams);
            return result;
          } else {
            return service;
          }
        }
        break;
      }
      default: {
        return list();
      }
    }
  } 
  
  //assume we are listing all services
  return list() as string;
}



