import ApiError from '@reactory/server-core/exceptions';
import fs from 'fs';
import { isArray } from 'lodash';
import { IReactorProject } from "@reactory/server-modules/reactory-reactor/types/service.types";
import Hash from '@reactory/server-core/utils/hash';

const getCatalogs = async (context: Reactory.Server.IReactoryContext): Promise<Partial<IReactorProject>[]> => {
  const catalogs: Partial<IReactorProject>[] = [];
  const { error, info } = context;
  let catalogJSON = require.resolve('./catalog.json');
  if(fs.existsSync(catalogJSON)) {
    // load the JSON file
    try {
      info(`Reading file ${catalogJSON}`)
      const fileJSON: any = JSON.parse(fs.readFileSync(catalogJSON, 'utf-8'));
      if(isArray(fileJSON)) {
        (fileJSON as Partial<IReactorProject>[]).forEach((elem) => {
          let fqn = `${elem.nameSpace}.${elem.name}_catalog_item`;
          const id = Hash(`${fqn}`);
          info(`Adding catalog ${fqn} with hash`);
          catalogs.push({
            id,                       
            ...elem
          })
        })        
      }
      info(`Found ${catalogs.length} catalogs`);
      return catalogs;
    } catch(err) {
      const msg = `Error reading file ${catalogJSON}: ${err.message}`;
      error(msg);
      throw new ApiError(msg, { hint: `Check the file catalog.json located @ ${catalogJSON} exists and is an array` });
    } 
  }

  return catalogs;
}

export default getCatalogs;