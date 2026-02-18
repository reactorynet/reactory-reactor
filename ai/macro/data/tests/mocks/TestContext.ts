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
    roles: ['USER'],
    avatar: 'https://www.gravatar.com/a'
  }

  const testPartner: Partial<Reactory.Models.IReactoryClientDocument> = { 
    __v: 0,
    _id: partnerId,
    key: 'test-partner-key',
    name: 'Test Partner',
  }

  const testContext: Partial<Reactory.Server.IReactoryContext> = { 
    user: testUser as unknown as Reactory.Models.IUserDocument,
    partner: testPartner as unknown as Reactory.Models.IReactoryClientDocument,
  }

  return await ReactoryContextProvider(null, testContext as Reactory.Server.IReactoryContext)
}