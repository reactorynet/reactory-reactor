import fs from 'fs'; 
import path from 'path';
import { default as ApiError } from "@reactory/server-core/exceptions"
import { 
  IReactorProject, 
  IReactorProjectFileSpec, 
  IProjectProcessor, 
  ISystemGraphManager, 
  AttributeProvider,
  ReactorNodeAttributes,
  KnownReactorProjectTypes
} from "@reactory/server-modules/reactory-reactor/types/service.types";

import Hash from "@reactory/server-core/utils/hash";
import { ReactorDataNode, ReactorNode, ReactorNodeType } from '@reactory/server-modules/reactory-reactor/types/model.types';

import SVGS from '@reactory/server-modules/reactory-reactor/data/reactor-svgs';
import { PagingRequest } from '@reactory/server-core/database/types';
import { service } from '@reactory/server-core/application/decorators';

@service({ 
  name: "ReactNativeProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for catalogging and creating a graph for a given system",
  id: "reactor.ReactNativeProjectProcessor@1.0.0",
  serviceType: "data",    
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },      
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService"}
  ],
})
class ReactNativeProjectProcessor implements IProjectProcessor, AttributeProvider {
  
  context: Reactory.Server.IReactoryContext;
  description?: string;
  tags?: string[];
  nameSpace: string = "reactor";
  name: string = "ReactNativeProjectProcessor";
  version: string = "1.0.0";
  props: any;

  searchService: Reactory.Service.ISearchService;
  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.props = props;
    this.context = context;
  }
 setFileSpecs(project: Partial<IReactorProject>, specs: Partial<IReactorProjectFileSpec>[]): Promise<Partial<IReactorProject>> {
  throw new Error('Method not implemented.');
 }
 getProjectData(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
  throw new Error('Method not implemented.');
 }

  getFileSpecs(project: IReactorProject): Partial<IReactorProjectFileSpec>[] {
    throw new Error('Method not implemented.');
  }
  sync(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }
  index(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }
  getProjectNode(project: IReactorProject): Promise<Partial<ReactorDataNode<IReactorProject>>> {
    const projectNode = {
      id: project.id,
      index: Hash(project.id),
      key: `${project.id}`,
      name: project.name,
      version: project.version,
      nameSpace: project.nameSpace,
      providerId: project.providerId,
      source: project.repoPath,
      type: ReactorNodeType.SYSTEM,
      categories: [],
      description: project.description,
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: project,
    }

    return Promise.resolve(projectNode);

    return Promise.resolve(projectNode);
  }

  getChildrenForNode(node: Partial<ReactorNode>, treeKey: string, filter: string, paging: PagingRequest): Promise<ReactorNode[]> {
    return Promise.resolve([]);
  }

  getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    const attributes: ReactorNodeAttributes[] = [];
    
    if(SVGS["react-native"]) {
      attributes.push({
        id: Hash(`${node.id}_icon-svg`),
        key: "icon",        
        value: { 
          type: "svg",
          svg: SVGS["react-native"]
        }
      })
    }
    return Promise.resolve(attributes);
  }

  process(project: IReactorProject): Reactory.Models.ISearchable[] {
    const searchables: Reactory.Models.ISearchable[] = [];
    const { context } = this;
    const { warn, info, error } = context;

    const { files } = project;
    if (!files) {
      error(`No files found for project ${project.name}`);
      throw new ApiError(`No files found for project ${project.name}`, 500);
    }
    
    let nextProject = { ...project };
    if(!nextProject.files) nextProject.files = [];
    const { pathSpecs } = nextProject;

    if (!pathSpecs) {
      error(`No path specs found for project ${project.name}`);
      throw new ApiError(`No path specs found for project ${project.name}`, 500);
    }

    pathSpecs.forEach((pathSpec) => { 
      if(fs.existsSync(pathSpec.path)) { 
        // list files that match the filter in the path
        const files = fs.readdirSync(pathSpec.path).filter((file) => file.endsWith(pathSpec.filter));
        // add the files to the project
        nextProject.files = [...nextProject.files, ...files.map<Partial<IReactorProjectFileSpec>>((file) => ({ type: pathSpec.type, path: path.join(pathSpec.path, file) }))];
      } else {
        warn(`Path ${pathSpec.path} does not exist`);
      }
    });

    if (!nextProject.files) {
      error(`No files found for project ${project.name}`);
      throw new ApiError(`No files found for project ${project.name}`, 500);
    }

    // for each of the files, we need to read the contents and create a searchable
    files.forEach((file) => {       
      const fileContents = fs.readFileSync(file.path, 'utf-8');
      const lines = fileContents.split('\n'); 
      
      const idString = `${project.nameSpace}.${project.name}_${file.type}_${file.path.split(path.sep).pop()}`;
      
      searchables.push({
        id: Hash(idString),
        name: `${file.type}_${file.path.split(path.sep).pop()}`,
        nameSpace: project.nameSpace,
        version: project.version,
        source: fileContents,
        path: file.path,
        metrics: [
          {
            unit: 'lines',
            value: lines.length,
            name: 'Line Count',
          }
        ],
        type: {
          id: file.type,
          name: file.type
        }
      });
    });


    return searchables;
  }

  onStartup(): Promise<void> {
    return Promise.resolve();
  }

  toString?(includeVersion?: boolean): string {
    return `${this.name}.${this.nameSpace}${includeVersion ? `@${this.version}` : ''}`;
  }
  
  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }

  setExecutionContext(executionContext: Reactory.Server.IReactoryContext): void {
    this.context = executionContext;
  }

  setFileService(fileService: Reactory.Service.IReactoryFileService): void { 
    this.fileService = fileService;
  }

  setFetchService(fetchService: Reactory.Service.IFetchService): void { 
    this.fetchService = fetchService;
  }

  setReactorySearchService(searchService: Reactory.Service.ISearchService): void { 
    this.searchService = searchService;
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    // Check for package.json and react-native in dependencies
    try {
      const pkgPath = path.join(root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['react-native'];
      }
    } catch {
      // ignore errors
    }
    return false;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    // React Native project type
    return this.supportsProject(project) ? ['react-native'] : [];
  } 
}

export default ReactNativeProjectProcessor;