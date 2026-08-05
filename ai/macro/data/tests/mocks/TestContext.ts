import Reactory from "@reactorynet/reactory-core";
import ReactoryContextProvider from "@reactory/server-core/context/ReactoryContextProvider";
import { ObjectId } from "mongodb";

export const DEFAULT_ROLES = ['USER', 'TESTER'];
export const EXEC_ROLES = ['USER', 'SHELL-EXEC'];

/**
 * Creates a mock Reactory context for testing. 
 */
export default async (roles: string[] = DEFAULT_ROLES): Promise<Reactory.Server.IReactoryContext> => {

  const userId: ObjectId = new ObjectId(1);
  const partnerId: ObjectId = new ObjectId(2);

  const testUser: Partial<Reactory.Models.IUserDocument> = {
    __v: 0,
    _id: userId,
    id: userId.toString(),
    firstName: 'Test',
    lastName: 'User',
    email: 'test@mail.com',
    username: 'test-user',
    // Honour the roles the caller asked for; the parameter used to be ignored,
    // leaving every mock user with a bare ['USER'].
    roles,
    avatar: 'https://www.gravatar.com/a'
  }

  const testPartner: Partial<Reactory.Models.IReactoryClientDocument> = {
    __v: 0,
    _id: partnerId,
    key: 'test-partner-key',
    name: 'Test Partner',
    // ReactoryContextProvider.extend() reads the "context-provider" client
    // setting, so a partner mock must answer getSetting or context creation
    // throws "this.partner.getSetting is not a function" — which took out every
    // macro suite that builds a test context. Returning { data: undefined }
    // means "no setting", so extend() leaves the context as-is.
    getSetting: <T>(_name: string, defaultValue?: T) => ({ data: defaultValue as T }),
    settings: [],
  }

  const testContext: Partial<Reactory.Server.IReactoryContext> = { 
    user: testUser as unknown as Reactory.Models.IUserDocument,
    partner: testPartner as unknown as Reactory.Models.IReactoryClientDocument,
  }

  return await ReactoryContextProvider(null, testContext as Reactory.Server.IReactoryContext)
}