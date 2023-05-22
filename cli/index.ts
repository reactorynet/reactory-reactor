import Reactory from '@reactory/reactory-core';
import ReactorCli from './reactor-cli/main';
type ReactoryCliApp = (vargs: string[]) => Promise<void>

/**
 * ReactorCliApp definition
 */
const ReactorCliApp: Reactory.IReactoryComponentDefinition<ReactoryCliApp> = {
  nameSpace: 'reactor',
  name: 'ReactorCli',
  version: '1.0.0',
  description: `Reactory Reactor CLI. Use this AI assistant to help you with your Reactory tasks.
  This CLI is powered by OpenAI's GPT-3 API. You will need an OpenAI API key to use this CLI.
  The CLI accepts the following command line arguments:
  --apikey=<your api key>
  --apiorg=<your api org>
  --modelid=<your model id>`,
  component: ReactorCli,
  domain: 'cli',
  features: [{
    feature: 'chat',
    featureType: 'ai',
    action: ["chat", "interact", "talk", "speak"],
    description: 'Chat with the Reactory AI assistant',
    stem: 'chat',
  }],
  enabled: true,
  overwrite: false,
  roles: ['USER'],
  dependencies: [],
  stem: 'reactor',
  tags: ['reactor', 'cli', 'assistant', 'ai'],
  toString(includeVersion) {
    return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
  },

}

const ReactoryCliApps: Reactory.IReactoryComponentDefinition<ReactoryCliApp>[] = [
  ReactorCliApp,
];

export default ReactoryCliApps;