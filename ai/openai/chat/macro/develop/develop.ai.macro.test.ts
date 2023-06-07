import fs, { existsSync, readFile, readFileSync } from 'fs';
import {
  CodeReview,
  CodeReviewFile,
  GitMacro,
} from './develop.ai.macro';
import { FileMacros } from '../fs/file.ai.macro';
import TestChatState from '../tests/mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactor/types/chat.types';
import { CreateChatCompletionRequest, OpenAIApi } from 'openai';

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

describe('CodeReview macros', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({
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
  it('should successfully check out a branch from a git repository', async () => {
    const repo = 'git@github.com:keegz1998/eng-test.git';
    const target = '${process.env.APP_DATA_ROOT}/projects/eng-test';
    const branch = 'master';
    const args = [
      'clone',
      repo,
      target,
      branch,
      'true'
    ];
    const result = await GitMacro(args, chatState);
    expect(result).toEqual(`Successfully cloned the repository ${repo} to ${target} and checked out branch ${branch}`);
    const reviewArgs = [
      `${process.env.APP_DATA_ROOT}/projects/eng-test`,
      `${__dirname}/samples/hello-world.spec.md`,
      'inline'
    ];
    const codeReview = await CodeReview(reviewArgs, chatState);
    expect(result).toBeTruthy();
    //@ts-ignore

  }, 30000)
});