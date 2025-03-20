import OpenAI from "openai";
import { 
  ChatFactory, 
  getInitializerMessage
} from '@reactory/server-modules//reactory-reactor/ai/openai/chat/questions/factory';
import { ask, colors } from '@reactory/server-modules//reactory-reactor/helpers';
import { ChatState } from "@reactory/server-modules//reactory-reactor/ai/openai/types/chat";
import readline, { ReadLine } from 'readline';
import { MacroRegistry } from "@reactory/server-modules//reactory-reactor/ai/openai/chat/macro";
import CANNED_MESSAGES from "@reactory/server-modules//reactory-reactor/cli/reactor-cli/messages";
import logger from "@reactory/server-core/logging";
import { ObjectId } from "mongodb";
import AIPersonaProvider from "@reactory/server-modules/reactory-reactor/services/PersonaService";


const DEFAULT_MODEL_ID = 'grok-2-latest';

const ReactorCli = async (kwargs: string[], context: Reactory.Server.IReactoryContext): Promise<void> => {

  let apiKey = process.env.OPENAI_API_KEY;
  let apiOrg = process.env.OPENAI_ORG;
  let modelId = process.env.OPENAI_DEFAULT_MODEL_ID || DEFAULT_MODEL_ID;
  let botId = process.env.REACTOR_BOT_ID || 'ReactorAIPersona';
  const persona = await context.getService<AIPersonaProvider>('reactor.AIPersonaProvider@1.0.0')?.getPersona(botId);

  if(!persona) { 
    context.error(`No persona found for botId: ${botId}`);
    return;
  }

  const modelState: ChatState = {
    id: new ObjectId().toHexString(),
    host: 'cli',
    botId,
    persona,
    modelId: modelId || DEFAULT_MODEL_ID,
    started: new Date(),
    history: [
    ],
    apiKey,
    apiOrg,
    context,
    macros: MacroRegistry,
    ai: new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: apiKey,
    }),
    vars: {
      __created: new Date().valueOf(),
      __botId: botId,
    }
  }
  modelState.history.push(await getInitializerMessage(botId, modelState, context));

  const rl: ReadLine = context.readline as ReadLine;

  rl.setPrompt(colors.yellow('[Reactor]> '));
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
    const configuration = {
      organization: apiOrg,
      apiKey: apiKey,
    };

    const openai = new OpenAI(configuration);

    if (!modelId || modelId === '' || modelId === 'select') {
      const modelListData = await openai.models.list();

      let responseText = '';

      modelListData.data.forEach((model) => {
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