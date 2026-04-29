import Reactory from '@reactorynet/reactory-core';
import ReactorCli from './reactor-cli/ReactorCli';
import ReactorTuiApp from './reactor-tui/ReactorTui';
import GraphManagerCLI from './SystemGraphManager/GraphManager';
import BackfillUsageCLI from './backfill-usage/BackfillUsage';
type ReactoryCliApp = (vargs: string[], context: Reactory.Server.IReactoryContext) => Promise<void>

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
    action: ["chat", "interact", "talk", "speak", "generate", "automation", "ai", "assistant", "bot", "reactory"],
    description: 'Chat with the Reactory AI assistant',
    stem: 'chat',
  }],
  overwrite: false,
  roles: ['USER'],
  stem: 'reactor',
  tags: ['reactor', 'cli', 'assistant', 'ai'],
  toString(includeVersion) {
    return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
  },

}

const ReactoryCliApps: Reactory.IReactoryComponentDefinition<ReactoryCliApp>[] = [
  ReactorCliApp,
  GraphManagerCLI,
  BackfillUsageCLI,
  {
    nameSpace: 'reactor',
    name: 'ReactorTui',
    version: '1.0.0',
    description: `Reactory Reactor TUI — a blessed-based terminal UI for AI chat with full feature parity to the ReactorChat PWA widget.
  Supports SSE streaming, personas, tools, voice, file attachments, and more.
  Usage: reactor-tui [--http --api-url=<url> --token=<jwt>]`,
    component: ReactorTuiApp,
    domain: 'cli',
    features: [{
      feature: 'tui',
      featureType: 'ai',
      action: ["tui", "chat", "interact", "talk", "ai", "assistant", "reactor-tui"],
      description: 'Interactive TUI chat with the Reactory AI assistant',
      stem: 'tui',
    }],
    overwrite: false,
    roles: ['USER'],
    stem: 'reactor-tui',
    tags: ['reactor', 'cli', 'tui', 'assistant', 'ai', 'blessed'],
    toString(includeVersion) {
      return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
    },
  },
];

export default ReactoryCliApps;