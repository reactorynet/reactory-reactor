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
import { service } from 'application/decorators';

@service({
  name: "JavaProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for catalogging and creating a graph for a given system",
  id: "reactor.JavaProjectProcessor@1.0.0",
  serviceType: "data",   
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },      
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService"}
  ],
})
class JavaProjectProcessor implements IProjectProcessor, AttributeProvider {
  
  context: Reactory.Server.IReactoryContext;
  description?: string;
  tags?: string[];
  nameSpace: string = "reactor";
  name: string = "JavaProjectProcessor";
  version: string = "1.0.0";
  props: any;

  searchService: Reactory.Service.ISearchService;
  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.props = props;
    this.context = context;
  }
 async setFileSpecs(project: Partial<IReactorProject>, specs: Partial<IReactorProjectFileSpec>[]): Promise<Partial<IReactorProject>> {
  if (!project) throw new ApiError('Project is required', 400);
  if (!specs) throw new ApiError('Specs are required', 400);

  // Merge or replace file specs on the project
  const updatedProject = { ...project, fileSpecs: specs };
  // Optionally persist changes if needed (e.g., via fileService)
  // await this.fileService.saveProjectFileSpecs(updatedProject);

  return updatedProject;
 }

 async getProjectData(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
  if (!project?.repoPath) throw new ApiError('Project repoPath is required', 400);

  // Gather basic project data
  const repoPath = project.repoPath;
  const stats = fs.existsSync(repoPath) ? fs.statSync(repoPath) : null;
  const files: IReactorProjectFileSpec[] = stats && stats.isDirectory()
   ? fs.readdirSync(repoPath).map(file => ({
    id: Hash(`${project.nameSpace}.${project.name}_${file}`),
     type: fs.statSync(path.join(repoPath, file)).isDirectory() ? 'directory' : 'file', 
     projectId: project.id,
     name: file,
     content: null,
     path: path.join(repoPath, file),
     isDirectory: fs.statSync(path.join(repoPath, file)).isDirectory(),
    }))
   : [];

  return {
   ...project,
   fileCount: files.length,
   files,
   lastModified: stats?.mtime,
  };
 }

  supportsProject(project: Partial<IReactorProject>): boolean {
    // Check for common Java build files in the root of the project
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    const javaBuildFiles = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'gradlew',
      'mvnw',
      'build.xml', // Ant
    ];
    try {
      for (const file of javaBuildFiles) {
        if (fs.existsSync(path.join(root, file))) {
          return true;
        }
      }
    } catch {
      // ignore errors, treat as not supported
    }
    return false;
  }
  
  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    if (!this.supportsProject(project)) return undefined;
    const root = project.repoPath;
    if (!root) return undefined;
    if (fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'mvnw'))) {
      return ['java']; // Maven
    }
    if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts')) || fs.existsSync(path.join(root, 'gradlew'))) {
      return ['gradle'];
    }
    if (fs.existsSync(path.join(root, 'build.xml'))) {
      return ['ant'];
    }
    return ['java']; // Default to java if any build file is present
  }

  getFileSpecs(project: IReactorProject): Partial<IReactorProjectFileSpec>[] {
    return [];
  }

  sync(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }

  index(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }


  getProjectNode(project: IReactorProject): Promise<Partial<ReactorDataNode<IReactorProject>>> {
    const projectNode: Partial<ReactorDataNode<IReactorProject>> = {
      id: project.id as number,
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
  }
  getChildrenForNode(node: Partial<ReactorNode>, treeKey: string, filter: string, paging: PagingRequest): Promise<ReactorNode[]> {
    return Promise.resolve([]);
  }

  getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    const attributes: ReactorNodeAttributes[] = [];
    
    // @ts-ignore
    if(SVGS["java"]) {
      attributes.push({
        id: Hash(`${node.id}_icon-svg`),
        key: "icon",
        value:  {
          type: "svg",
          // @ts-ignore
          svg: SVGS["java"]
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
        //@ts-ignore
        nextProject.files = [
          ...nextProject.files, 
          ...files.map<Partial<IReactorProjectFileSpec>>((file, idx) => ({
            id: idx, // id should be a number for IReactorProjectFileSpec 
            type: pathSpec.type, 
            path: path.join(pathSpec.path, file) 
          }))];
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
}

export default JavaProjectProcessor;