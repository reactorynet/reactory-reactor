import { ChatState, Macro, MacroComponentDefinition, MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import Reactory from "@reactory/reactory-core";

export const GetUser: Macro<string> = async (
  args: string[],
  state: ChatState) => {
  const [ email ] = args;
  const userService = state.context?.getService<Reactory.Service.IReactoryUserService>('core.UserService@1.0.0');

  if (!userService) {
    return 'No user service found';
  }

  const user = await userService.findUserWithEmail(email)

  if (!user) {
    return `No user found with email ${email}`;
  }

  return JSON.stringify({ id: user.id, firstName: user.firstName, lastName: user.lastName }) as string;
}

export const GetUserRegistry: MacroComponentDefinition<typeof GetUser> = {
  nameSpace: 'reactor-macros',
  name: 'getUser',
  version: '1.0.0',
  component: GetUser,
  description: `# getUser macro
  Use this macro to retrieve user information by email
  
  ## Usage
  @getUser(email) - returns user details for the specified email
  `,
  features: [
    {
      feature: 'find',
      featureType: Reactory.FeatureType.function,
      action: ['find', 'get', 'retrieve', 'lookup'],
      description: 'Operation that finds a user by email.',
      stem: 'find'
    }
  ],
  stem: 'user',
  tags: ['user', 'find', 'email', 'lookup'],
  tools: [{
    type: "function",
    function: {
      name: "getUser",
      description: "Retrieve a user by their email address",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "The email address of the user to find"
          }
        },
        required: ["email"]
      }
    }
  }]
}

/**
 * Creates a new user with the given email, first name, and last name
 * @param args - string[] - [ email, firstName, lastName ]
 * @param context 
 * @returns 
 */
export const CreateUser: Macro<string> = async (
  args: string[], 
  state: ChatState) => {
  const [ email, firstName, lastName ] = args;  
  const userService = state.context?.getService<Reactory.Service.IReactoryUserService>('core.UserService@1.0.0');

  if (!userService) {
    return 'No user service found';
  }

  try {
    let user = await userService.findUserWithEmail(email);

    if (user) {
      return `User with email ${email} already exists`;
    }

    user = await userService.createUser({
      email,
      firstName,
      lastName,    
    });

    if (!user) {
      return `Failed to create user with email ${email}`;
    }

    return JSON.stringify({ id: user.id, firstName, lastName, email }) as string;
  } catch (error) {
    console.error('Error creating user:', error);
    return `Error creating user: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const CreateUserRegistry: MacroComponentDefinition<typeof CreateUser> = {
  nameSpace: 'reactor-macros',
  name: 'createUser',
  version: '1.0.0',
  component: CreateUser,
  description: `# createUser macro
  Use this macro to create a new user with the specified email, first name, and last name
  
  ## Usage
  @createUser(email, firstName, lastName) - creates a new user and returns the details
  `,
  features: [
    {
      feature: 'create',
      featureType: Reactory.FeatureType.function,
      action: ['create', 'add', 'register', 'new'],
      description: 'Operation that creates a new user.',
      stem: 'create'
    }
  ],
  stem: 'user',
  roles: ['ADMIN'],
  tags: ['user', 'create', 'register', 'new'],
  tools: [{
    type: "function",
    function: {
      name: "createUser",
      description: "Create a new user with the specified details",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: "Arguments for creating the user follows the pattern [ email, firstName, lastName ]",
            items: {
              type: "string"
            }
          },          
        },
        required: ["args"]
      }
    }
  }]
}