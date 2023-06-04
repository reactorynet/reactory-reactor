import { ChatState, Macro } from "modules/reactor/types/chat.types"

import { exec } from "child_process";

/**
 * A macro that executes a shell command.
 * @param args - a list of arguments for the shell command
 * @param state - the current chat state
 * @param context - the current reactory context
 * @returns the result of the shell command
 */
export const ShellCommand: Macro<string> = async (args: any[], state: ChatState, context?: Reactory.Server.IReactoryContext) => {

  // define a helper function to execute a shell command
  const execCommand = (command: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(`Error: ${error.message}`);
        } else if (stderr) {
          reject(`Stderr: ${stderr}`);
        } else {
          resolve(stdout);
        }
      });
    });
  };

  // check if a command is provided
  if (args && args.length > 0) {
    try {
      const result = await execCommand(args.join(' '));
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



