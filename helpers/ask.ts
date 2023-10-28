import { colors, stripColorCodes } from './index';
import { IQuestion, ChatState } from '@reactory/server-modules/reactor/ai/openai/types/chat';
import { handleChatCompletionResponse } from '@reactory/server-modules/reactor/ai/openai/chat/macro';
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
export const ask = async (question: IQuestion, state: ChatState, rl: ReadLine): Promise<ChatState> => {
  try {
    const { botId = 'Reactor', context } = state;
    const { i18n, log } = context;
    const { t } = i18n;

    if (question !== null && question !== undefined) {
      const $response = await new Promise<string>((resolve) => {

        if(question.question.includes("@")) {
          // the bot has responded with an @ which signals macro processing.
          // we process the macro and send the information back as "me" the user.
          rl.write(colors.green(`bot has is requesting permission to execute macros`));
          rl.close();
        } else {
          // default flow
          let nextPrompt = `${colors.yellow(`[${botId}]>`)}${colors.green(`${question.question}`)}\n[me]>`;
          if (question.question === "") {
            nextPrompt = '[me]>'
          }
          rl.question(nextPrompt, (response: string) => {
            resolve(response);
          });
        }
      });

      if (question.handler) {
        const handlerResponse = await question.handler(stripColorCodes($response), state);
        return ask(handlerResponse.next, handlerResponse.state, rl);
      }
    } else {
      rl.write(colors.green(`${t('reactor:chat.goodbye')}\r`));
      rl.close();
    }

    return state;
  } catch (error) {
    // Handle the error gracefully (e.g., log, throw, or return a default state)
    console.error('Error occurred in ask:', error);
    throw error;
  }
};
