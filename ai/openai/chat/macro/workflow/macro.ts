import Reactory from "@reactory/reactory-core";
import { readFileSync } from "fs";
import { ChatState, Macro } from "modules/reactory-reactor/ai/openai/types/chat";

/**
 * A macro that lists all services registered in the system or
 * returns the service with the given name / fqn.
 * @param args - a list of arguments for the service register macro
 * @param state - the current chat state
 * @param context - the current reactory context
 * @returns 
 */
export const ServiceRegister: Macro<string | object | object[]> = async (args: any[], state: ChatState) => {
  
  const list = (format: string = 'string'): string | object => {
    const { services } = state.context;
    if(services && services.length > 0) {
      if(format === 'string') {
        return services.map(s => `${s.id} -> ${s.description || 'No description available'}`).join('\n');
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
        const service = state.context?.getService<any>(`${nameSpace}.${name}@${version}`, props);
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

export const ServiceRegisterComponentDefinition: Reactory.IReactoryComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: ServiceRegister,
  name: 'svc',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./ServiceRegister.md')).toString(),
  features: [],
  stem: 'mutation',
  tags: ['macro', 'graphql', 'mutation'],
};

