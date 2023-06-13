
import { GitMacro } from './git.macro';
import {
  CodeReview,
  CodeReviewFile,
} from '../review';
import { FileMacros } from '../../fs/fs.macro';
import TestChatState from '../../data/tests/mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactor/types/chat.types';
import { CreateChatCompletionRequest, OpenAIApi } from 'openai';
import { GitMacroArgs } from './git.macro.types';
import { cwd } from 'process';

const mockReviewFileContent = `# Review for hello-world file
Nice work!
`;

const mockReviewDirectory = `# Review for hello-world folder structure
Nice work!
`;


const mockReviewFileObject = (content: string) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: content,
      }
    }
  ]
})
// Define or import the getAIResponse function here before mocking it

jest.mock('@reactory/server-modules/reactor/ai/openai/chat/questions/factory', () => {
  return {
    getAIResponse: async (ai: OpenAIApi, prompt: CreateChatCompletionRequest, state: ChatState) => {
      let response = mockReviewFileObject('');
      if (prompt.messages[0].content.includes('Write code review for:')) {
        response = mockReviewFileObject(mockReviewFileContent);
      }

      if (prompt.messages[0].content.includes('Write a review on file structure for the following directory')) {
        response = mockReviewFileObject(mockReviewDirectory);
      }

      return response;
    },
    createPrompt: (modelId: string, message: string, history: any[], role?: string) => {
      let messages = [
        ...history,
        {
          role: role || 'assistant',
          content: message,
        },
      ];

      return {
        model: modelId,
        messages: messages,
      };
    }
  }
});

describe('Git Macro Test', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({
      macros: [
        ...FileMacros,
        CodeReview,
        CodeReviewFile
      ],
      roles: ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'],
    });
  });

  // Test 1: successfully checks out a branch from a git repository
  it('should successfully check the status of the current git repository', async () => {
    const target =  cwd();
    const args = [
      'status',
      ".",
      target,
    ];
    //add the ssh key to the chat state
    chatState.vars.sshKey = `${process.env.HOME}/.ssh/id_reactor_ed25519`;
    const result = await GitMacro(args, chatState);
    expect(result).toContain('On branch');

  }, 5000);
});