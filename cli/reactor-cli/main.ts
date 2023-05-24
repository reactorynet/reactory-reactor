import { Configuration, OpenAIApi } from "openai";
import { 
  ChatFactory, 
  SYSTEM_INITIALIZER_MESSAGE 
} from '@reactory/server-modules/reactor/ai/openai/chat/questions/factory';
import { ask, colors } from '@reactory/server-modules/reactor/helpers';
import { ChatState } from "@reactory/server-modules/reactor/types/chat.types";
import readline from 'readline';

const DEFAULT_MODEL_ID = 'gpt-3.5-turbo-0301';

const main = async (kwargs: string[]) => {

  let apiKey = process.env.OPENAI_API_KEY;
  let apiOrg = process.env.OPENAI_ORG;
  let modelId = process.env.OPENAI_MODEL_ID || DEFAULT_MODEL_ID;

  const modelState: ChatState = {
    botId: 'Reactor',
    modelId: modelId || DEFAULT_MODEL_ID,
    started: new Date(),
    history: [
      SYSTEM_INITIALIZER_MESSAGE
    ],
    apiKey,
    apiOrg,
    ai: new OpenAIApi(new Configuration({
      organization: apiOrg,
      apiKey: apiKey,
    })),
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `> `,
    terminal: true,
  });

  rl.on('close', () => {
    console.log('Goodbye.')
    process.exit(0);
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

  rl.write(colors.yellow(`
+---------------------------------------------------------------------------+
| Welcome to the reactory ai helper utility. This utility will help you     |\r
| perform some basic AI (chatgpt) specific operations against the code base.|\r
| For more help on each question, respond with ? to get more help on the    |\r
| use of each prompt.                                                       |\r
|                                                                           |\r
|                 !!This tool is still under development!!                  |\r
+---------------------------------------------------------------------------+
`));

  if (!apiKey || !apiOrg) {
    rl.write(colors.yellow(`
  +---------------------------------------------------------------------------+
  | Error: You must provide an apikey and apivalue to use this tool.          |\r
  | Add the following keys in your environment file                           |\r
  |    * OPENAI_API_KEY                                                       |\r
  |    * OPENAI_ORG                                                           |\r
  | or specify the values in the command line using the params                |\r
  |    * --apikey=<your api key>                                              |\r
  |    * --apiorg=<your api value>                                            |\r
  +---------------------------------------------------------------------------+
  `));
    rl.close();
    return;
  }

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

main(process.argv);

export default main;