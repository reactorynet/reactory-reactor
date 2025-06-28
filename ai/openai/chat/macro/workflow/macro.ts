import Reactory from "@reactory/reactory-core";
import { readFileSync } from "fs";
import { ChatState, Macro } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ServiceRegisterProps } from './types';

/**
 * A macro that lists all services registered in the system or
 * returns the service with the given name / fqn.
 * @param props - ServiceRegisterProps - { action, name, nameSpace, version, props, func, funcParams, format }
 * @param state - the current chat state
 * @returns 
 */
export const ServiceRegister: Macro<string | object | object[], ServiceRegisterProps> = async (props: ServiceRegisterProps, state: ChatState) => {
  
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

  const { action, name, nameSpace, version, props: serviceProps = null, func = null, funcParams, format = 'string' } = props;

  if(action) {
    switch(action) {
      case 'list': {
        return list(format);
      }
      case 'get': { 
        if (name && nameSpace && version) {
          const service = state.context?.getService<any>(`${nameSpace}.${name}@${version}`, serviceProps);
          if(service) {
            if(func && funcParams) { 
              const result = await service[func](...funcParams);
              return result;
            } else {
              return service;
            }
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
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'graphql', 'mutation'],
};
