import logger from '@reactory/server-core/logging';
import { fileAsString } from '@reactory/server-core/utils/io';

const ReactorTypeDefinitions: string[] = [];
[
  'ReactorChat'
].forEach((name) => { 
  try {
    const fileName = `./${name}.graphql`;
    logger.debug(`Adding [REACTOR][${fileName}]`);
    const source = fileAsString(require.resolve(fileName));
    ReactorTypeDefinitions.push(`${source}`);
  } catch (e) {
    logger.error(`Error loading type definition, please check file: ${name}`, { error: e });
  }
});

export default ReactorTypeDefinitions;