import { ReadLine } from 'readline';
import { ask } from './ask';
import { ChatState, IQuestion } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * `ask` drives one turn of the interactive CLI chat loop: it prints the bot's
 * question through a readline interface, waits for the user's line, hands it to
 * the question's handler, then recurses into whatever question the handler
 * returns next. A null/undefined question ends the session.
 *
 * The previous version of this suite never ran one assertion against real
 * behaviour: it mocked `openai-api` (a package that is not installed) inside
 * `beforeEach`, asserted `toHaveBeenCalledTimes` on `ask` itself — the real
 * function, not a mock — omitted `state.persona`, which `ask` dereferences
 * immediately, and built a full ReactoryContext, booting the whole module
 * registry for a function that needs only `context.i18n.t`. Everything here is
 * a plain stub, so the suite is fast and hermetic.
 */

/** A ReadLine double that records what was written and answers prompts. */
const makeReadLine = (answers: string[] = []) => {
  const queue = [...answers];
  const rl = {
    written: [] as string[],
    prompts: [] as string[],
    closed: false,
    question: jest.fn((prompt: string, callback: (response: string) => void) => {
      rl.prompts.push(prompt);
      callback(queue.length > 0 ? queue.shift()! : '');
    }),
    write: jest.fn((chunk: string) => {
      rl.written.push(chunk);
      return true;
    }),
    close: jest.fn(() => {
      rl.closed = true;
    }),
  };
  return rl;
};

const makeState = (overrides: Partial<ChatState> = {}): ChatState =>
  ({
    personaId: 'Reactor',
    persona: { id: 'Reactor', name: 'Reactor' },
    modelId: 'test-model',
    apiKey: 'test-key',
    apiOrg: 'test-org',
    history: [],
    started: new Date(),
    vars: {},
    macros: [],
    context: {
      i18n: { t: (key: string) => key },
      log: jest.fn(),
    },
    ...overrides,
  } as unknown as ChatState);

describe('ask', () => {
  it('prompts with the bot name and the question, then returns the state', async () => {
    const rl = makeReadLine(['John Doe']);
    const state = makeState();

    const result = await ask(
      { question: 'What is your name?' } as IQuestion,
      state,
      rl as unknown as ReadLine
    );

    expect(rl.question).toHaveBeenCalledTimes(1);
    expect(rl.prompts[0]).toContain('Reactor');
    expect(rl.prompts[0]).toContain('What is your name?');
    // No handler, so the turn ends and the state comes back unchanged.
    expect(result).toBe(state);
  });

  it('passes the answer to the handler with colour codes stripped', async () => {
    const rl = makeReadLine(['\x1b[32mJohn Doe\x1b[39m']);
    const state = makeState();
    const handler = jest.fn().mockResolvedValue({ next: null, state });

    await ask(
      { question: 'Name?', handler } as unknown as IQuestion,
      state,
      rl as unknown as ReadLine
    );

    expect(handler).toHaveBeenCalledWith('John Doe', state);
  });

  it('follows the handler to the next question until one has no handler', async () => {
    const rl = makeReadLine(['first', 'second']);
    const state = makeState();

    const second = { question: 'Second?' } as IQuestion;
    const firstHandler = jest.fn().mockResolvedValue({ next: second, state });

    await ask(
      { question: 'First?', handler: firstHandler } as unknown as IQuestion,
      state,
      rl as unknown as ReadLine
    );

    expect(firstHandler).toHaveBeenCalledWith('first', state);
    expect(rl.prompts).toHaveLength(2);
    expect(rl.prompts[1]).toContain('Second?');
  });

  it("carries the handler's updated state into the next turn", async () => {
    const rl = makeReadLine(['answer', 'again']);
    const state = makeState();
    const updated = makeState({ vars: { seen: true } });

    const secondHandler = jest.fn().mockResolvedValue({ next: null, state: updated });
    const second = { question: 'Second?', handler: secondHandler } as unknown as IQuestion;
    const firstHandler = jest.fn().mockResolvedValue({ next: second, state: updated });

    const result = await ask(
      { question: 'First?', handler: firstHandler } as unknown as IQuestion,
      state,
      rl as unknown as ReadLine
    );

    expect(secondHandler).toHaveBeenCalledWith('again', updated);
    expect(result).toBe(updated);
  });

  it('uses a bare prompt for an empty question', async () => {
    const rl = makeReadLine(['something']);

    await ask({ question: '' } as IQuestion, makeState(), rl as unknown as ReadLine);

    expect(rl.prompts[0]).toBe('[me]>');
  });

  it('falls back to the readline on the state when none is passed', async () => {
    const rl = makeReadLine(['answer']);
    const state = makeState({ rl: rl as unknown as ReadLine });

    await ask({ question: 'Q?' } as IQuestion, state);

    expect(rl.question).toHaveBeenCalledTimes(1);
  });

  describe('ending the session', () => {
    it.each([null, undefined])('says goodbye and closes on a %p question', async (question) => {
      const rl = makeReadLine();
      const state = makeState();

      const result = await ask(question as unknown as IQuestion, state, rl as unknown as ReadLine);

      expect(rl.written.join('')).toContain('reactor:chat.goodbye');
      expect(rl.closed).toBe(true);
      expect(rl.question).not.toHaveBeenCalled();
      expect(result).toBe(state);
    });

    it('closes the session when the bot asks to run macros', async () => {
      // A question containing "@" signals that the bot wants permission to run
      // macros. That flow is unimplemented: the branch writes a notice, closes
      // the readline and ends the turn. It used to hang instead — see ask.ts.
      const rl = makeReadLine();
      const state = makeState();

      const result = await ask(
        { question: 'may I run @shell?' } as IQuestion,
        state,
        rl as unknown as ReadLine
      );

      expect(rl.written.join('')).toContain('macros');
      expect(rl.closed).toBe(true);
      expect(rl.question).not.toHaveBeenCalled();
      expect(result).toBe(state);
    });
  });

  describe('failure', () => {
    it('rethrows when the readline throws', async () => {
      const rl = makeReadLine();
      rl.question = jest.fn(() => {
        throw new Error('Error occurred');
      });
      const handler = jest.fn();

      await expect(
        ask(
          { question: 'Q?', handler } as unknown as IQuestion,
          makeState(),
          rl as unknown as ReadLine
        )
      ).rejects.toThrow('Error occurred');
      expect(handler).not.toHaveBeenCalled();
    });

    it('rethrows when the handler rejects', async () => {
      const rl = makeReadLine(['answer']);
      const handler = jest.fn().mockRejectedValue(new Error('handler exploded'));

      await expect(
        ask(
          { question: 'Q?', handler } as unknown as IQuestion,
          makeState(),
          rl as unknown as ReadLine
        )
      ).rejects.toThrow('handler exploded');
    });

    it('rethrows when the state has no persona', async () => {
      const rl = makeReadLine(['answer']);

      await expect(
        ask(
          { question: 'Q?' } as IQuestion,
          makeState({ persona: undefined }),
          rl as unknown as ReadLine
        )
      ).rejects.toThrow();
    });
  });
});
