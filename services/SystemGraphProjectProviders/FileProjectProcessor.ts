import fs from 'fs'; 
import path from 'path';
import { default as ApiError } from "@reactory/server-core/exceptions"
import { 
  IReactorProject, 
  IReactorProjectFileSpec, 
  IProjectProcessor, 
  ReactorNodeAttributes
} from "@reactory/server-modules/reactor/types/service.types";

import Hash from "@reactory/server-core/utils/hash";

import { PagingRequest } from 'database/types';
import { ReactorNode, ReactorNodeType } from '@reactory/server-core/modules/reactor/types/model.types';

class FileProjectProcessor implements IProjectProcessor {
  getFileSpecs(project: IReactorProject): Partial<IReactorProjectFileSpec>[] {
    throw new Error('Method not implemented.');
  }
  sync(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }
  index(project: IReactorProject): Promise<IReactorProject> {
    throw new Error('Method not implemented.');
  }
  getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    throw new Error('Method not implemented.');
  }
  getProjectNode(project: IReactorProject): Promise<Partial<ReactorDataNode<IReactorProject>>> {
    const projectNode = {
      id: project.id,
      index: Hash(project.id),
      name: project.name,
      key: `${project.id}`,
      version: project.version,
      nameSpace: project.nameSpace,
      providerId: project.providerId,
      source: project.source,
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
  
  context: Reactory.Server.IReactoryContext;
  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;

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
}

export default FileProjectProcessor;