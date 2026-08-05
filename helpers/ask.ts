import { colors, stripColorCodes } from './index';
import { IQuestion, ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { handleChatCompletionResponse } from '@reactory/server-modules/reactory-reactor/ai/openai/chat/macro';
import { ReadLine } from 'readline';


/**
 * Asks a question and returns a response.
 * If the question is null, the configuration is persisted to the file system.
 *
 * @param { IQuestion } question - The question to ask the user.
 * @param { ChatState } state - The current state of the chat.
 * @param { ReadLine } rl - The ReadLine interface for user input / output.
 * @returns { Promise<ChatState>} A promise that resolves to the updated ChatState.
 * @throws { Error } If an error occurs during the execution.
 */
export const ask = async (question: IQuestion, state: ChatState, rl?: ReadLine): Promise<ChatState> => {
  try {
    const { context, persona } = state;
    const { i18n, log } = context;
    const { t } = i18n;
    const botName = persona.name;
    const _rl = rl || state.rl;
    if (question !== null && question !== undefined) {
      if (question.question.includes("@")) {
        // The bot has responded with an @, which signals that it wants
        // permission to execute macros. That flow is not implemented; the
        // session ends here.
        //
        // This used to sit inside the response promise and write + close
        // without ever calling resolve(), so the `await` below never settled
        // and `ask` hung forever — the CLI simply stopped responding. Returning
        // ends the turn instead.
        _rl.write(colors.green(`bot is requesting permission to execute macros`));
        _rl.close();
        return state;
      }

      const $response = await new Promise<string>((resolve) => {
        let nextPrompt = `${colors.yellow(`[${botName}]>`)}${colors.green(`${question.question}`)}\n[me]>`;
        if (question.question === "") {
          nextPrompt = '[me]>'
        }
        _rl.question(nextPrompt, (response: string) => {
          resolve(response);
        });
      });

      if (question.handler) {
        const handlerResponse = await question.handler(stripColorCodes($response), state);
        return ask(handlerResponse.next, handlerResponse.state, rl);
      }
    } else {
      _rl.write(colors.green(`${t('reactor:chat.goodbye')}\r`));
      _rl.close();
    }

    return state;
  } catch (error) {
    // Handle the error gracefully (e.g., log, throw, or return a default state)
    console.error('Error occurred in ask:', error);
    throw error;
  }
};
