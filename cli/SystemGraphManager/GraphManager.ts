import { ReadLine } from "readline";
import fs from 'fs';
import { ask, colors } from '@reactory/server-modules/reactory-reactor/helpers';
import { IReactorProject, ISystemGraphManager, ReactorProjectProcessingStatus, ReactorProjectService, ReactorProjectStatus } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { patch } from "superagent";
import Reactory from "@reactory/reactory-core";

type ReactoryCliApp = (vargs: string[], context: Reactory.Server.IReactoryContext) => Promise<void>
/**
 * The graph manager CLI is a command line interface for managing and building a 
 * system graph.
 * 
 * Commands can be used to add nodes to the graph, remove nodes from the graph,
 * build the graph, index the graph, and search the graph.
 * 
 * parameters:
 * -a --add <filepath> eg -a ./path/to/file
 * -r --remove <filepath> eg -r ./path/to/file
 * -p --processor <processor-id> eg. reactor.SimpleProjectProcessor@1.0.0
 * -sid --system-id <system-id> Default is Reactory, eg. -sid Reactory
 * -gid --graph-id <graph-id> Default is SystemGraphv eg. -gid SystemGraph
 * -i --index <sid> eg. -i Reactory
 * -s --search <term> eg. -s "search term"
 * -o --output <filepath> eg. -o ./path/to/file
 * -fmt --format <format> eg. -fmt json
 * -h --help
 * -s --silent
 */
const GraphManagerCli: ReactoryCliApp = async (kwargs: string[], context: Reactory.Server.IReactoryContext): Promise<void> => { 
  
  const rl: ReadLine = context.readline as ReadLine;
  
  if(kwargs.length === 0) { 
    context.error(`No arguments provided`);
    process.exit(1);
  }
  
  if(context === undefined || context === null) { 
    context.error(`No context provided`);
    process.exit(1);
  }

  let add: string[] = [];
  let remove: string[] = [];
  let processor: string = 'reactor.SimpleProjectProcessor@1.0.0';
  let systemId: string = 'Reactory';
  let graphId: string = 'SystemGraph';
  let doIndex: boolean = false;
  let deleteIndex: boolean = false;
  let createCatalog: boolean = false;
  let catalogPath: string = '';
  let patchData: any = null;
  let organization: string = null;
  let doSearch: boolean = false;
  let searchTerm: string = '';
  let output: string = '';
  let format: string = 'json';
  let silent: boolean = false;
  let help: boolean = false;
  let verbose: boolean = false;
  let indexKey = 'reactory_SystemGraph';
  for (const kwarg of kwargs) {
    let arg: string;
    let argv: string | boolean = null;
    if (kwarg.indexOf('=') === -1) {
      arg = kwarg;
      argv = true;
    } else {
      arg = kwarg.split('=')[0];
      argv = kwarg.split('=')[1];
    }

    switch (arg) {
      case '--dindex': {
        deleteIndex = true;
        indexKey = argv as string ? argv as string : `graph_${systemId}_${graphId}`;
        break;
      }
      case '-a':
      case '--add':
        add.push(argv as string);
        break;
      case '-r':
      case '--remove':
        remove.push(argv as string);
        break;
      case '-c':
      case '--catalog':
        createCatalog = true;
        catalogPath = argv as string;
        break;
      case '--patchfile': 
        patchData = fs.readFileSync(argv as string, 'utf-8');
        patchData = JSON.parse(patchData);
        break;
      case '-proc':
      case '--processor':
        processor = argv as string;
        break;
      case '-sid':
      case '--sid':
        systemId = argv as string;
        indexKey = `reactor_graph_${systemId}_${graphId}`;
        break;
      case '-gid':
      case '--gid':
        graphId = argv as string;
        indexKey = `reactor_graph_${systemId}_${graphId}`;
        break;
      case '-org':
      case '--organization':
        organization = argv as string;
        break;
      case '-i':
      case '--index':
        // doIndex = true; // Removed useless assignment
        break;
      case '-s':
      case '--search':
        // doSearch = true; // Removed useless assignment
        // searchTerm = argv as string; // Removed useless assignment
        break;
      case '-o':
      case '--output':
        // output = argv as string; // Removed useless assignment
        break;
      case '-fmt':
      case '--format':
        // format = argv as string; // Removed useless assignment
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      case '--silent':
        // silent = true; // Removed useless assignment
        break;
      case '-v':
      case '--verbose':
        // verbose = true; // Removed useless assignment
        break;
      default:
        break;
    }
  }

  if(help === true) { 
    rl.write(colors.green(`
    Reactory GraphManagerCLI. Use this CLI to manage your Reactory system graph.
    to provide a visual representation of your application architecture. The CLI accepts the following command line arguments:
    --add=<filepath> eg --add=./path/to/file
    --catalog=<catalog-path> eg --catalog=./path/to/catalog
    --remove=<filepath> eg -remove=./path/to/file
    --processor=<processor-id> eg. --processor=reactor.SimpleProjectProcessor@1.0.0
    --sid=<system-id> Default is Reactory, eg. --sid Acme
    --gid=<graph-id> Default is SystemGraphv eg. --gid AcmeGraph
    --index=<sid> eg. -i Reactory
    --dindex=<sid> eg. --dindex --sid=Acme --gid=AcmeGraph
    --search=<term> eg. -s "search term"
    --output=<filepath> eg. -o ./path/to/file
    --format=<format> eg. -fmt json
    --organization=<organization-name> eg. --organization=Acme
    --help
    --silent
    `));
    rl.close();
    process.exit(0);
  }

  if(deleteIndex === true) { 
    context.info(`Deleting index graph_${systemId}_${graphId}`);
    const searchSvc = context.getService<Reactory.Service.ISearchService>('core.ReactorySearchService@1.0.0');
    await searchSvc.deleteIndex(indexKey);
    process.exit(0);
  }

  if(add.length > 0) {
    context.info(`Processing ${add.length} locations`);
    const graphSvc = context.getService<ISystemGraphManager>('reactor.SystemGraphManager@1.0.0');
    const searchSvc = context.getService<Reactory.Service.ISearchService>('core.ReactorySearchService@1.0.0');

    for(const path of add) { 
      context.info(`Adding location ${path}`);
      const project = await graphSvc.getProject(path);
      project.nameSpace = systemId;
      project.name = graphId;
      project.version = '1.0.0';
      const catalog = await graphSvc.catalogProject(project);
      const result = await searchSvc.index(indexKey, catalog);
    }
  }

  if(remove.length > 0) {
    context.info(`Removing ${remove.length} locations`);
    const graphSvc = context.getService<ISystemGraphManager>('reactor.SystemGraphManager@1.0.0');
    const searchSvc = context.getService<Reactory.Service.ISearchService>('core.ReactorySearchService@1.0.0');

    for(const path of remove) { 
      context.info(`Removing location ${path}`);
      const project = await graphSvc.getProject(path);
      project.nameSpace = systemId;
      project.name = graphId;
      project.version = '1.0.0';
      const catalog = await graphSvc.catalogProject(project);
      await searchSvc.deleteIndex(indexKey);      
    }
  
  }

  if (createCatalog) {
    if (!catalogPath || catalogPath.trim() === '') {
      context.error(`Catalog path is required when using --catalog option.`);
      process.exit(1);
    }

    if (!fs.existsSync(catalogPath) || !fs.lstatSync(catalogPath).isDirectory()) {
      context.error(`Catalog path '${catalogPath}' does not exist or is not a directory.`);
      process.exit(1);
    }
    context.info(`Cataloging all subfolders in ${catalogPath}`);
    const projectSvc = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    const folders = fs.readdirSync(catalogPath).filter(f => fs.lstatSync(`${catalogPath}/${f}`).isDirectory());
    for (const folder of folders) {
      // if the folder is a special folder like .git, skip it
      if (folder.startsWith('.') || folder === 'node_modules') {
        context.info(`Skipping special folder: ${folder}`);
        continue;
      }
      const folderPath = `${catalogPath}/${folder}`;      
      try {
        let patchItem: Partial<IReactorProject> = null;
        if (patchData) { 
          // check if patch data is an array or single object.
          // if the patchData is an array, we try and match the folder name with the patchData name
          if (Array.isArray(patchData)) {
            patchItem = patchData.find((item: any) => item.name === folder);            
          } else if (typeof patchData === 'object' && patchData.name === folder) {
            patchItem = patchData;
          }
        }

        const partialOrganization: Partial<Reactory.Models.TOrganization> = {
          name: patchItem?.organization?.name || organization || null,
          description: patchItem?.organization?.description,
          created: new Date(),
          updated: new Date(),
        };

        const businessUnit: Partial<Reactory.Models.TBusinessUnit> = {
          name: patchItem?.businessUnit?.name || null,
          description: patchItem?.businessUnitDescription || null,
          created: new Date(),
          updated: new Date(),
        }

        const project: Partial<IReactorProject> = { 
          nameSpace: systemId,
          name: folder,
          version: 'unknown',
          repoPath: folderPath,
          repoUrl: patchItem?.repoUrl || `https://github.com/${organization}/${folder}.git`,
          organization: partialOrganization?.name ? partialOrganization : null,
          businessUnit: businessUnit?.name ? businessUnit : null,
          files: [], 
          pathSpecs: [],
          description: null,
          fqn: `${systemId}.${folder}@unknown`,
          created: new Date(),
          updated: new Date(),
          dependencies: [],
          tasksUrl: '',
          primaryDocumentation: null,
          secondaryDocumentation: [],
          primarySlackChannel: null,
          secondarySlackChannels: [],
          owner: patchItem?.owner || context?.user || null,
          ownerTeam: patchItem?.ownerTeam || null,
          teams: [],
          engineers: [],
          activeBranch: 'main',
          mainBranch: 'main',
          branches: ['main'],
          tags: [],
          processors: [],
          client: context?.partner || null,
          projectStatus: ReactorProjectStatus.ACTIVE,
          processingHistory: [],
          errors: [],
          notes: [],
          security: {
            securityPoliciesUrl: '',
            encryptionAtRest: false,
            encryptionInTransit: false,
            dependenciesWithKnownVulnerabilities: 0,
            vulnerabilityReportUrl: ''
          }
        };

        await projectSvc.catalogProject(project);
        context.info(`Cataloged: ${folderPath}`, {}, 'GraphManagerCli');
      } catch (err) {
        context.error(`Failed to catalog ${folderPath}: ${err.message}`);
      }
    }
    process.exit(0);
  }
};

/**
 * ReactorCliApp definition
 */
const ReactorCliAppDefinition: Reactory.IReactoryComponentDefinition<ReactoryCliApp> = {
  nameSpace: 'reactor',
  name: 'GraphManagerCli',
  version: '1.0.0',
  description: `Reactory GraphManagerCLI. Use this CLI to manage your Reactory system graph.
  to provide a visual representation of your application architecture. The CLI accepts the following command line arguments:
  -a --add <filepath> eg -a ./path/to/file
  -r --remove <filepath> eg -r ./path/to/file
  -p --processor <processor-id> eg. reactor.SimpleProjectProcessor@1.0.0
  -sid --system-id <system-id> Default is Reactory, eg. -sid Reactory
  -gid --graph-id <graph-id> Default is SystemGraphv eg. -gid SystemGraph
  -i --index <sid> eg. -i Reactory
  -s --search <term> eg. -s "search term"
  -o --output <filepath> eg. -o ./path/to/file
  -fmt --format <format> eg. -fmt json
  -h --help
  -s --silent
  `,
  component: GraphManagerCli,
  domain: "cli",
  features: [],
  overwrite: false,
  roles: ['USER'],
  stem: 'manager',
  tags: ['graph', 'cli', 'assistant'],
  toString(includeVersion) {
    return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
  },

}

export default ReactorCliAppDefinition;
