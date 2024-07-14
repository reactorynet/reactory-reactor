
import {
  CodeReview,
  CodeReviewFile,
} from './macro';
import { FileMacros, RemoveDirectory } from '../../fs/macro';
import git from '../git';
import TestChatState from '../../data/tests/mocks/ChatState';
import { ChatState } from 'modules/reactory-reactor/ai/openai/types/chat';
import { CreateChatCompletionRequest, OpenAIApi } from 'openai';
import logger from '@reactory/server-core/logging';
import { GitMacroArgs } from '../git/types';
import { existsSync } from 'fs-extra';

const mockReviewFileContent = `# Review for hello-world file
Nice work!
`;

const mockReviewDirectory = `# Review for hello-world folder structure
Nice work!
`;

const mockReviewSummary = `# Review for hello-world file
Nice work!
`


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
      const  { content } = prompt.messages[0]
      if (content.startsWith('Write code review for:')) {
        response = mockReviewFileObject(mockReviewFileContent);
      }

      if (content.startsWith('Write a review on file structure for the following directory:')) {
        response = mockReviewFileObject(mockReviewDirectory);
      }

      if (content.startsWith('Summarize and format the review generated')) {
        response = mockReviewFileObject(mockReviewSummary);
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

describe('CodeReview macros', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({
      roles: ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'],
      macros: [
        ...FileMacros,
        CodeReview,
        CodeReviewFile
      ]
    });
  });

  // Test 1: successfully performs a code review
  it('should successfully perform a code review on the unit test file', async () => {
    const filePath = __dirname;
    const args = [
      `${filePath}/samples/hello-world.ts`,
      `${filePath}/samples/hello-world.spec.md`,
      'inline'
    ];
    const result = await CodeReviewFile(args, chatState);
    logger.info(result);
    expect(result).toBeTruthy();
  });

  // Test 2: successfully performs a code review on a path
  it('should successfully perform a code review on a path', async () => {
    const filePath = __dirname;
    const args = [
      `${filePath}/samples`,
      `${filePath}/samples/hello-world.spec.md`,
      'inline'
    ];
    const result = await CodeReview(args, chatState);
    expect(result).toBeTruthy();
    //@ts-ignore
  }, 30000);

  // Test 3: successfully checks out a branch from a git repository
  it('should successfully check out a branch from a git repository and perform a review', async () => {    

    const target = `${process.env.APP_DATA_ROOT}/projects/reactory-core`;
    if (existsSync(target)) { 
      await RemoveDirectory([target], chatState);
    }

    const args: GitMacroArgs = [
      'clone',
      'git@github.com:reactorynet/reactory-core.git',
      target,
      'master',
      'true',
    ];
    const result = await git(args, chatState);
    expect(result).toContain(`Successfully cloned the repository`);    
    //@ts-ignore
  }, 180000);

  it('successfull performs a code review on a git repository', async () => { 
    const target = `${process.env.APP_DATA_ROOT}/projects/reactory-core`;
    const reviewArgs = [
      target,
      `${__dirname}/samples/hello-world.spec.md`,
      'inline'
    ];
    const codeReview = await CodeReview(reviewArgs, chatState);
    expect(codeReview).toBeTruthy();
    //@ts-ignore
  }, 180000);
});