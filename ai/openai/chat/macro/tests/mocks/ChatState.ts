import { ChatState } from "@reactory/server-modules/reactor/types/chat.types";
import { OpenAIApi } from "openai";
import ReactoryContextProvider from './TestContext'
import { ObjectId } from "mongodb";

const MockAI: OpenAIApi = jest.genMockFromModule('openai');

const getMockChatState = async ({ 
  macros = [], 
  ai = MockAI,
}): Promise<ChatState> => {

  const context = await ReactoryContextProvider();
  const userId = new ObjectId(1).toString();
  const apiUser: Reactory.Models.IApiStatus = {
    id: 'mock-api-user-id',
    loggedIn: {
      id: userId,
      user: context.user as unknown as Reactory.Models.IUser,
      memberships: [],
      additional: [],
      organization: null,
      businessUnit: null,
      altRoles: [],
      roles: ['USER', 'TESTER'],
      team: null,
    },
    when: undefined,
    status: "",
    firstName: "",
    lastName: "",
    menus: [],
    navigationComponents: []
  };

  const MockChatState: ChatState = {
    botId: 'Reactor',
    modelId: 'gpt-3.5-turbo-0301',
    started: new Date(),
    history: [],
    ai,
    macros,
    apiKey: 'mock-api-key',
    apiOrg: 'mock-api-org',
    context: context,
    authToken: 'mock-auth-token',
    user: apiUser,
  };

  return MockChatState;
}

export default getMockChatState;