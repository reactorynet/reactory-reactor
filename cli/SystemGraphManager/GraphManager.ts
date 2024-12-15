import { ReadLine } from "readline";
import { ask, colors } from 'modules/reactory-reactor/helpers';
import { ISystemGraphManager } from "modules/reactory-reactor/types/service.types";

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
  let doSearch: boolean = false;
  let searchTerm: string = '';
  let output: string = '';
  let format: string = 'json';
  let silent: boolean = false;
  let help: boolean = false;
  let verbose: boolean = false;
  let indexKey = 'reactory_SystemGraph';
  for(let i = 0; i < kwargs.length; i++) { 
    let arg: string;
    let argv: string | boolean = null;
    if(kwargs[i].indexOf('=') === -1) { 
      arg = kwargs[i];
      argv = true;      
    } else {
      arg = kwargs[i].split('=')[0];
      argv = kwargs[i].split('=')[1];
    }

    switch(arg) { 
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
      case '-i':
      case '--index':
        doIndex = true;      
        break;
      case '-s':
      case '--search':
        doSearch = true;
        searchTerm = argv as string;
        break;
      case '-o':
      case '--output':
        output = argv as string;
        break;
      case '-fmt':
      case '--format':
        format = argv as string;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      case '-s':
      case '--silent':
        silent = true;
        break;
      case '-v':
      case '--verbose':
        verbose = true;
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
    --remove=<filepath> eg -remove=./path/to/file
    --processor=<processor-id> eg. --processor=reactor.SimpleProjectProcessor@1.0.0
    --sid=<system-id> Default is Reactory, eg. --sid Acme
    --gid=<graph-id> Default is SystemGraphv eg. --gid AcmeGraph
    --index=<sid> eg. -i Reactory
    --dindex=<sid> eg. --dindex --sid=Acme --gid=AcmeGraph
    --search=<term> eg. -s "search term"
    --output=<filepath> eg. -o ./path/to/file
    --format=<format> eg. -fmt json
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

export default ReactorCliAppDefinition