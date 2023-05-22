import { colors, stripColorCodes } from '../../../helpers/helpers';
import readline, { ReadLine } from 'readline';
import { IQuestion, ChatState } from '../../../types/chat.types';


/**
 * Asks a question and returns the response. If question is null, the configuration is persisted to the file system.
 * @param question - The question to ask the user
 * @param state - The current state of the chat
 */
export const ask = async (question: IQuestion, state: ChatState, rl: ReadLine): Promise<void> => {
  return new Promise((resolve) => {
    if (question !== null && question !== undefined) {
      rl.question(`
        ${colors.yellow('[reactory]>')}${colors.green(`${question.question}`)}
        `, async ($response: string) => {
        if (question.handler) {
          const handlerResponse = await question.handler(stripColorCodes($response), state);
          resolve(ask(handlerResponse.next, handlerResponse.state, rl));
        }
      });
    } else {
      rl.write(colors.green(`No more questions, goodbye!\r`));
      rl.close();
      resolve();
    }
  });
}
