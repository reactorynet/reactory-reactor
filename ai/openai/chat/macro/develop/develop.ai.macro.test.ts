import fs, { readFile, readFileSync } from 'fs';
import { 
  CodeReview, 
  CodeReviewFile 
} from './develop.ai.macro';
import TestChatState from '../tests/mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactor/types/chat.types';

const mockReviewContents = 'Good job, keep it up!';

// Define or import the getAIResponse function here before mocking it

jest.mock('getAIResponse', () => {
  return jest.fn().mockImplementation(() => {
    return {
      choices: [{
        message: {
          content: mockReviewContents
        }
      }]
    }
  })
})

describe('CodeReview macros', () => {
  let chatState: ChatState = null;

  beforeEach(async () => {
    jest.resetAllMocks();
    chatState = await TestChatState({ macros: [] });
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
});