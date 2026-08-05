import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * CodeReview / CodeReviewFile now take props objects and resolve structured
 * results; they used to take positional arrays and return strings.
 *
 * Two things made this suite unrunnable before:
 *
 *  1. The AI factory was mocked at `@reactory/server-modules/reactor/...`,
 *     missing the `reactory-` prefix, so the path did not resolve and the whole
 *     suite failed to load. The macro imports it from
 *     `@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory`.
 *  2. Two tests cloned `git@github.com:reactorynet/reactory-core.git` over SSH
 *     and reviewed the result — a 3-minute network- and credential-dependent
 *     round trip that cannot belong to a unit baseline. Reviewing a checked-out
 *     repository is worth an integration test; it is not one of these.
 *
 * The factory mock must be declared before the macro is imported, so it is
 * hoisted here and the macro is required lazily inside the tests.
 */

const REVIEW_FILE_CONTENT = '# Review for hello-world file\nNice work!\n';
const REVIEW_DIRECTORY_CONTENT = '# Review for hello-world folder structure\nNice work!\n';
const REVIEW_SUMMARY_CONTENT = '# Summary review\nNice work!\n';

const completion = (content: string) => ({
  choices: [{ message: { role: 'assistant', content } }],
});

jest.mock(
  '@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory',
  () => ({
    createPrompt: (modelId: string, message: string, history: any[], role?: string) => ({
      model: modelId,
      messages: [...(history || []), { role: role || 'assistant', content: message }],
    }),
    getAIResponse: async (_ai: unknown, prompt: { messages: { content: string }[] }) => {
      const content = prompt?.messages?.[0]?.content ?? '';
      if (content.startsWith('Write code review for:')) return completion(REVIEW_FILE_CONTENT);
      if (content.startsWith('Write a review on file structure for the following directory:')) {
        return completion(REVIEW_DIRECTORY_CONTENT);
      }
      if (content.startsWith('Summarize and format the review generated')) {
        return completion(REVIEW_SUMMARY_CONTENT);
      }
      return completion(REVIEW_FILE_CONTENT);
    },
    // Mirrors the real factory: returns the *message object*, so callers read
    // `.content` off it.
    extractResponse: (response: any, question: string) =>
      response?.choices?.[0]?.message ??
      response?.content ??
      `AI system failed to respond to the following prompt: ${question}`,
  })
);

// Imported after the mock is registered.
import { CodeReview, CodeReviewFile } from './macro';
import TestChatState from '../../data/tests/mocks/ChatState';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

describe('CodeReview macros', () => {
  let chatState: ChatState;
  let workDir: string;

  beforeEach(async () => {
    chatState = await TestChatState({
      macros: [],
      roles: ['USER', 'TESTER', 'ADMIN', 'SHELL-EXEC'],
    });
    workDir = fs.mkdtempSync(path.join(os.homedir(), '.reactor-review-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const writeFixture = (name: string, content: string): string => {
    const target = path.join(workDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  };

  describe('CodeReviewFile', () => {
    it('reviews a single file and returns the review inline', async () => {
      const target = writeFixture('hello-world.ts', 'export const hello = () => "world";\n');
      const result = await CodeReviewFile({ path: target, target: 'inline' }, chatState);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data?.review).toContain('Review for hello-world file');
      expect(result.data?.path).toBe(target);
      expect(result.data?.writtenToFile).toBe(false);
      expect(result.data?.reviewLength).toBeGreaterThan(0);
      expect(result.tool).toBeTruthy();
    });

    it('writes the review to disk when target is "file"', async () => {
      const target = writeFixture('hello-world.ts', 'export const hello = () => "world";\n');
      const targetPath = path.join(workDir, 'review.md');
      const result = await CodeReviewFile(
        { path: target, target: 'file', targetPath },
        chatState
      );

      expect(result.success).toBe(true);
      expect(result.data?.writtenToFile).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toContain('Review for hello-world file');
    });

    it('honours a specification file when one is supplied', async () => {
      const target = writeFixture('hello-world.ts', 'export const hello = () => "world";\n');
      const specs = writeFixture('hello-world.spec.md', '# Spec\nMust greet the world.\n');
      const result = await CodeReviewFile(
        { path: target, specs, target: 'inline' },
        chatState
      );

      expect(result.success).toBe(true);
      expect(result.data?.specs).toBe(specs);
    });

    it('reports a missing file rather than throwing', async () => {
      const result = await CodeReviewFile(
        { path: path.join(workDir, 'absent.ts'), target: 'inline' },
        chatState
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('CodeReview', () => {
    it('reviews every file in a directory', async () => {
      writeFixture('src/one.ts', 'export const one = 1;\n');
      writeFixture('src/two.ts', 'export const two = 2;\n');

      const result = await CodeReview(
        { path: path.join(workDir, 'src'), target: 'inline' },
        chatState
      );

      // CodeReview reviews the structure, then each file, then asks for a
      // summary — so the returned value is the summary, not a per-file review.
      expect(typeof result).toBe('string');
      expect(result).toContain('Summary review');
      // Each file's individual review is accumulated on the chat state.
      expect(chatState.vars.review).toContain('folder structure');
      expect(chatState.vars.review).toContain('Review for hello-world file');
    }, 30000);
  });
});
