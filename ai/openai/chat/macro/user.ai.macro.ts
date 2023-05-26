import { ChatState, Macro } from "@reactory/server-modules/reactor/types/chat.types";

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

  let user = await userService.findUserWithEmail(email);

  if (user) {
    return `User with email ${email} already exists`;
  }

  user = await userService.createUser({
    email,
    firstName,
    lastName,    
  });

  return JSON.stringify({ id: user.id, firstName, lastName, email }) as string;
}