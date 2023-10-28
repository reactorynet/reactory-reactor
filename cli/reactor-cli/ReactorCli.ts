import { Configuration, OpenAIApi } from "openai";
import { 
  ChatFactory, 
  SYSTEM_INITIALIZER_MESSAGE 
} from '@reactory/server-modules/reactor/ai/openai/chat/questions/factory';
import { ask, colors } from '@reactory/server-modules/reactor/helpers';
import { ChatState } from "modules/reactor/ai/openai/types/chat";
import readline, { ReadLine } from 'readline';
import { template } from 'lodash';
import { MacroRegistry } from "@reactory/server-modules/reactor/ai/openai/chat/macro";
import CANNED_MESSAGES from "@reactory/server-modules/reactor/cli/reactor-cli/messages";
import logger from "@reactory/server-core/logging";
import { ObjectId } from "mongodb";

const DEFAULT_MODEL_ID = 'gpt-3.5-turbo-0301';

const ReactorCli = async (kwargs: string[], context: Reactory.Server.IReactoryContext): Promise<void> => {

  let apiKey = process.env.OPENAI_API_KEY;
  let apiOrg = process.env.OPENAI_ORG;
  let modelId = process.env.OPENAI_MODEL_ID || DEFAULT_MODEL_ID;

  const getInitializerMessage = (state: ChatState) => {
    const macros = state.macros.map(macro => `## ${macro.name}\n ## Usage\n${macro.description}`).join('\n');
    return  {
      role: SYSTEM_INITIALIZER_MESSAGE.role,
      content: template(SYSTEM_INITIALIZER_MESSAGE.content)({ macros })
    }
  }


  const modelState: ChatState = {
    id: new ObjectId().toHexString(),
    botId: 'Reactor',
    modelId: modelId || DEFAULT_MODEL_ID,
    started: new Date(),
    history: [
    ],
    apiKey,
    apiOrg,
    context,
    macros: MacroRegistry,
    ai: new OpenAIApi(new Configuration({
      organization: apiOrg,
      apiKey: apiKey,
    })),
    vars: {
      __created: new Date().valueOf(),
    }
  }

  modelState.history.push(getInitializerMessage(modelState));

  const rl: ReadLine = context.readline as ReadLine;

  let pastedContent: string = '';

  // Function to sanitize the pasted content
  function sanitizeContent(content: string) {
    logger.info(`Sanitizing content\n: ${content}`);
    return content.trim();
  }

  const { 
    stdin,
    stdout
  } = process;

  process.stdin.on('paste', () => {

    pastedContent = stdin.read().toString();
    pastedContent = sanitizeContent(pastedContent);

    // Clear the original content from the prompt
    readline.cursorTo(stdout, 0);
    readline.clearLine(stdout, 1);

    // Write the sanitized content back to the prompt
    rl.write(pastedContent);

    // Move the cursor to the end of the line
    readline.moveCursor(stdout, pastedContent.length, 0);
  });

  rl.on('close', () => {
    console.log('Goodbye.')
    process.exit(0);
  });

  rl.on('line', (input) => {
    // If there's pasted content, ignore the line input
    if (input.trim() === '') {
      // Handle the case where only newline is entered
      // For example, ignore it or perform a specific action
      return;
    }

    if (pastedContent !== '') {
      rl.prompt();
      return;
    }
  });

  if (kwargs.length > 0) {
    kwargs.forEach((arg) => {
      const [key, value] = arg.split('=');
      if (key === '--apikey') {
        apiKey = value;
      }

      if (key === '--apiorg') {
        apiOrg = value;
      }

      if (key === '--modelid') {
        modelId = value;
      }
    })
  }

  rl.prompt(true);

  rl.write(colors.yellow(CANNED_MESSAGES.welcome));

  if (!apiKey || !apiOrg) {
    rl.write(colors.yellow(CANNED_MESSAGES.error));
    rl.close();
    return;
  }

  modelState.rl = rl;

  try {
    const configuration = new Configuration({
      organization: apiOrg,
      apiKey: apiKey,
    });

    const openai = new OpenAIApi(configuration);

    if (!modelId || modelId === '' || modelId === 'select') {
      const modelListData = await openai.listModels();

      let responseText = '';

      modelListData.data?.data?.forEach((model) => {
        responseText += `[id: ${model.id}] Owner: ${model.owned_by} Created: ${new Date(model.created * 1000).toISOString()} \r`;
      });

      rl.write(colors.yellow(`
+---------------------------------------------------------------------------+
| Please select the model you want to use for interaction.                  |\r
|                                                                           |\r
+---------------------------------------------------------------------------+
${responseText}
`));
    }
    await ask(ChatFactory(rl, modelState), modelState, rl);
    rl.close();
  } catch (ex) {
    rl.write(colors.yellow(`
+---------------------------------------------------------------------------+
| Error: ${ex}                                                              |\r
+---------------------------------------------------------------------------+
  `));
    rl.close();
    return;
  }
};

export default ReactorCli;