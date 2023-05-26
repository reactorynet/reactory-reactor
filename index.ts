import Reactory from '@reactory/reactory-core';
import ReactorGraphql from './graphql';
import Workflows from './workflow';
import ReactorCli from './cli';

const ClientCertificate = require.resolve('./certs/reactory-web-client.cert');
const {
  API_URI_ROOT,
  NODE_ENV
} = process.env as Reactory.Server.ReactoryEnvironment;

const ReactorModule: Reactory.Server.IReactoryModule = {
  nameSpace: 'reactory',
  version: '1.0.0',
  name: 'Reactor',
  dependencies: [],
  priority: 1,
  graphDefinitions: ReactorGraphql,
  workflows: Workflows,
  forms: [
    // Define your forms here
  ],
  services: [
    // Define your services here
  ],
  translations: [
    // Define your translations here
  ],
  models: [
    // Define your models here
  ],
  clientPlugins: [
    { 
      nameSpace: 'reactory',
      name: 'ReactorWebClient',
      version: '1.0.0',
      description: 'Reactory Reactor Web Client',
      platform: 'web',
      url: `${API_URI_ROOT}/plugins/reactor-web-client-plugin${NODE_ENV === 'production' ? '.min' : ''}.js`,
      enabled: true,
      id: 'reactor-web-client-plugin',
      loader: 'web',
      mimeType: 'application/javascript',
      options: {},
      roles: ['USER'],
    }
  ],
  cli: ReactorCli,
};

export default ReactorModule;
