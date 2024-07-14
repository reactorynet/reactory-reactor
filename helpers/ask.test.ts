import { ask } from './ask';
import { ChatState } from 'modules/reactory-reactor/ai/openai/types/chat';
import { ReadLine, createInterface } from 'readline';
import { ReactoryContext } from '@reactory/server-core/context';
import { OpenAIApi } from 'openai';

jest.mock('readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn((question, callback) => {
      // Mock readline question callback implementation
      callback('Mocked Response');
    }),
    write: jest.fn(),
    close: jest.fn(),
  }),
}));

jest.mock('colors/safe', () => ({
  setTheme: jest.fn(),
}));

// Mocking dependencies
const mockQuestion = {
  question: 'What is your name?',
  handler: jest.fn(),
};
let mockState: ChatState = null
let mockReadLine: ReadLine = null;
let mockOpenAI: OpenAIApi = null;

describe('ask function', () => {

  beforeEach(async () => {
    const context: Reactory.Server.IReactoryContext = await ReactoryContext("test-session-id", null);
    const ai = jest.mock('openai-api', () => jest.fn());
    mockState = {
      botId: 'Reactor',
      context,
      ai: mockOpenAI,
      modelId: 'test-model-id',
      apiKey: 'test-api-key',
      apiOrg: 'test-api-org',
      history: [],
      started: new Date(),
      vars: {},
      macros: []
    };
    mockReadLine = createInterface(process.stdin, process.stdout, undefined, false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should ask the question and return the updated state', async () => {
    // Mock readline question callback
    mockReadLine.question = jest.fn((_, callback) => {
      callback('John Doe');
    });

    // Mock question handler response
    const handlerResponse: any = {
      next: null,
      state: { /* updated state */ },
    };
    mockQuestion.handler.mockResolvedValue(handlerResponse);

    const result = await ask(mockQuestion, mockState, mockReadLine);

    expect(mockReadLine.question).toHaveBeenCalled();
    expect(mockQuestion.handler).toHaveBeenCalledWith('John Doe', mockState);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toEqual(handlerResponse.state);
  });

  it('should handle null question and return the state', async () => {
    const result = await ask(null, mockState, mockReadLine);

    expect(mockReadLine.write).toHaveBeenCalled();
    expect(mockReadLine.close).toHaveBeenCalled();
    expect(result).toEqual(mockState);
  });

  it('should handle undefined question and return the state', async () => {
    const result = await ask(undefined, mockState, mockReadLine);

    expect(mockReadLine.write).toHaveBeenCalled();
    expect(mockReadLine.close).toHaveBeenCalled();
    expect(result).toEqual(mockState);
  });

  it('should handle error and throw', async () => {
    // Mock readline question callback to throw an error
    mockReadLine.question = jest.fn((_, callback) => {
      throw new Error('Error occurred');
    });

    await expect(ask(mockQuestion, mockState, mockReadLine)).rejects.toThrowError('Error occurred');
    expect(mockReadLine.question).toHaveBeenCalled();
    expect(mockQuestion.handler).not.toHaveBeenCalled();
  });
});
