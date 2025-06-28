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
import { BackStageCatalogInfo, ReactorDataNode, ReactorNode, ReactorNodeType } from '@reactory/server-modules/reactory-reactor/types/model.types';

import SVGS from '@reactory/server-modules/reactory-reactor/data/reactor-svgs';
import { PagingRequest } from '@reactory/server-core/database/types';
import { service } from 'application/decorators';
import yaml from 'js-yaml';


// TODO: Import IProjectProcessor and any required types from the shared types location
// import { IProjectProcessor } from '../../types';

@service({
  name: "BackStageProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for catalogging and creating a graph for a given system",
  id: "reactor.BackStageProjectProcessor@1.0.0",
  serviceType: "data",   
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },      
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService"}
  ],
})
class BackStageProjectProcessor implements IProjectProcessor, AttributeProvider{
  
context: Reactory.Server.IReactoryContext;
  description?: string;
  tags?: string[];
  nameSpace: string = "reactor";
  name: string = "BackStageProjectProcessor";
  version: string = "1.0.0";
  props: any;

  searchService: Reactory.Service.ISearchService;
  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.props = props;
    this.context = context;
  }
 getFileSpecs(project: Partial<IReactorProject>): Partial<IReactorProjectFileSpec>[] {
  // Attempt to locate and describe the catalog-info.yaml file in the project root
  if (!project?.path) return [];
  const catalogPath = path.join(project.path, 'catalog-info.yaml');
  if (fs.existsSync(catalogPath)) {
   const stats = fs.statSync(catalogPath);
   return [{
    path: catalogPath,    
    type: 'yaml',
   }];
  }
  return [];
 }

 async setFileSpecs(
  project: Partial<IReactorProject>,
  specs: Partial<IReactorProjectFileSpec>[]
 ): Promise<Partial<IReactorProject>> {  
  // do nothing 
  return project;
 }

 process(project: Partial<IReactorProject>): Reactory.Models.ISearchable[] {
  throw new Error('Method not implemented.');
 }
 async getProjectData(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
  // read in the catalog-info.yaml file if it exists
  if (!project?.repoPath) throw new ApiError('Project repoPath is required');
  const catalogPath = path.join(project.repoPath, 'catalog-info.yaml');
  if (fs.existsSync(catalogPath)) {
   try {
    const catalogYaml = fs.readFileSync(catalogPath, 'utf8');
    // use a YAML parser to parse the catalog-info.yaml file
    const catalog: BackStageCatalogInfo = yaml.load(catalogYaml, { json: true }) as BackStageCatalogInfo;
     // process each document in the YAML file
    const projectProps: Partial<IReactorProject> = this.context.utils.objectMapper.merge(catalog, {
     'metadata.name': 'name',
     'metadata.description' : 'description',
     'metadata.links': 'secondaryDocumentation',
     'metadata.links[0]': 'primaryDocumentation',
     'spec.owner': { 
       key: 'team',
       transform: (owner: string) => { 
        // group:zepz-engineering/zepz-engineering-pi-platform
        // use a regex to extract the owner name from the group
        if (!owner) return null;
        const match = owner.match(/^(.*?)(?:\/|$)/);
        if (!match) return null;
        const ownerName = match[1];
        if (!ownerName) return null;
        // return the owner name as an object 
        return {
         name: ownerName,
        }
       },
       default: null,
      },
    });
    
    return Promise.resolve({
     ...project,
     ...projectProps,
    });
   } catch (error) {
    throw new ApiError(`Error reading catalog-info.yaml: ${error.message}`);
   }
  }

 }

 getProjectSubTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
  throw new Error('Method not implemented.');
 }
 sync(project: IReactorProject): Promise<IReactorProject> {
  throw new Error('Method not implemented.');
 }
 index(project: IReactorProject): Promise<IReactorProject> {
  throw new Error('Method not implemented.');
 }
 toString?(includeVersion?: boolean): string {
  throw new Error('Method not implemented.');
 }
 getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
  throw new Error('Method not implemented.');
 }
 getProjectNode(project: Partial<IReactorProject>): Promise<Partial<ReactorDataNode<Partial<IReactorProject>>>> {
  throw new Error('Method not implemented.');
 }
 getChildrenForNode(node: Partial<ReactorNode>, treeKey: string, filter: string, paging: PagingRequest): Promise<ReactorDataNode<any>[]> {
  throw new Error('Method not implemented.');
 }

  supportsProject(project: Partial<IReactorProject>): boolean {
    // check if the project has a repoPath and if it contains a catalog-info.yaml file
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    // Check for catalog-info.yaml in the project root
    try {
      return fs.existsSync(path.join(root, 'catalog-info.yaml'));
    } catch (error) {
      this.context.error(`Error checking project path: ${error.message}`);
    }    
    return false;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    // Stub: Return the project type
    return this.supportsProject(project) ? ['backstage'] : [];
  }
}

export default BackStageProjectProcessor;