import Reactory from "@reactory/reactory-core";
import { ObjectId } from "mongodb";
import { ReactorProjectService, IReactorProject, PageReactorProjectResult, ReactorNodeAttributes, KnownReactorProjectTypes, IProjectProcessor, IProjectProcessorConfig } from "../types/service.types";
import { PagingRequest, PagingResult } from "@reactory/server-core/database/types";
import { ReactorProjectModel } from "../models/ReactorProject";
import { service } from "@reactory/server-core/application/decorators";
import { 
 JavaProjectProcessor,
 TSqlProjectProcessor,
 CSharpProjectProcessor,
 NodeJSProjectProcessor,
 ReactNativeProjectProcessor,
 PythonProjectProcessor,
 BackStageProjectProcessor 
}from "./SystemGraphProjectProviders";

@service({
 id: "reactor.ReactorProjectService@1.0.0",
 name: "ReactorProjectService",
 nameSpace: "reactor",
 version: "1.0.0",
 description: "Service for CRUD operations on Reactor Projects",
 serviceType: "data",
 dependencies: [],
})
class ReactorProjectServiceImpl implements ReactorProjectService {
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;
  nameSpace = "reactor";
  name = "ReactorProjectService";
  version = "1.0.0";

  private processors: Record<string, IProjectProcessor> = {};

  constructor(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.props = props;
    this.context = context;   
    // configure processors
    this.processors["java"] = new JavaProjectProcessor(props, context);
    this.processors["tsql"] = new TSqlProjectProcessor(props, context);
    this.processors["csharp"] = new CSharpProjectProcessor(props, context);
    this.processors["nodejs"] = new NodeJSProjectProcessor(props, context);
    this.processors["reactnative"] = new ReactNativeProjectProcessor(props, context);
    this.processors["python"] = new PythonProjectProcessor(props, context);     
    this.processors["backstage"] = new BackStageProjectProcessor(props, context);
  }


 async detectProjectTypes(project: Partial<IReactorProject>): Promise<KnownReactorProjectTypes[]> {
  // Check if the project has a processor that supports it
  let projectTypes: KnownReactorProjectTypes[] = [];
  const { context } = this;
  //Iterate through processors to find a match
  for (const processor of Object.values(this.processors)) {
    if (processor.supportsProject(project)) {
      // check if the processor has a getProjectTypes method
       if (typeof processor.getProjectTypes === 'function') { 
        const types = processor.getProjectTypes(project) as KnownReactorProjectTypes[];
        if (types && types.length > 0) {
          projectTypes = [...projectTypes, ...types];
        }
       } else {
        // log a warning if the processor does not implement getProjectTypes
        context.warn(`Processor ${processor.name} does not implement getProjectTypes method`);
       }
    }
  }
  return projectTypes;
 }
 
 async detectProjectProcessors(project: Partial<IReactorProject>): Promise<IProjectProcessorConfig[]> {
  // Check if the project has a processor that supports it
  let processors: IProjectProcessorConfig[] = [];
  
  // If not, iterate through processors to find a match
  for (const processor of Object.values(this.processors)) {
    if (processor.supportsProject(project)) {
       const fqn = `${processor.nameSpace}.${processor.name}@${processor.version}`;
       processors.push({
        id: fqn,
        processor: fqn,        
       });
    }
  }
  return processors;
 }

 description?: string;
 tags?: string[];
 toString?(includeVersion?: boolean): string {
  throw new Error("Method not implemented.");
 }

  async getProjects(filter?: Partial<any>): Promise<PageReactorProjectResult> {
    let query = filter?.comparitor || {};
    const search = filter?.search || "";
    const page = filter?.paging?.page || 1;
    const pageSize = filter?.paging?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    // If search string is specified, add a case-insensitive regex to the query for project name
    if (search && search.trim().length > 0) {
      query = {
        ...query,
        name: { $regex: search, $options: 'i' }
      };
    }
    const total = await ReactorProjectModel.countDocuments(query);
    const projectsRaw = await ReactorProjectModel.find(query).skip(skip).limit(pageSize).lean();
    const projects: Partial<IReactorProject>[] = projectsRaw.map((p: any) => ({ ...p, id: this.context.utils.hash(p._id.toString()) }));

    return {
      projects,
      paging: {
        total,
        page,
        pageSize,
        hasNext: skip + projects.length < total
      }
    };
  }

  async getProject(idOrPath: string): Promise<Partial<IReactorProject>> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = { $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }] };
    }
    return ReactorProjectModel.findOne(query).lean();
  }

  async createProject(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
    const created = await ReactorProjectModel.create(project);
    return created as Partial<IReactorProject>;
  }

  async updateProject(idOrPath: string, updates: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = { $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }] };
    }
    const updated = await ReactorProjectModel.findOneAndUpdate(query, updates, { new: true }).lean();
    return updated as Partial<IReactorProject>;
  }

  async deleteProject(idOrPath: string): Promise<boolean> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = { $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }] };
    }
    const result = await ReactorProjectModel.deleteOne(query);
    return result.deletedCount > 0;
  }

  async catalogProject(projectSpec: Partial<IReactorProject>): Promise<Partial<IReactorProject>> {
    if (!projectSpec.repoPath && !projectSpec.repoUrl) {
      throw new Error("Project must have a repoPath or repoUrl to be cataloged");
    }

    // Helper to update an existing project
    const updateProjectFields = async (project: Partial<IReactorProject>, spec: Partial<IReactorProject>) => {
      Object.keys(spec).forEach(key => {
        if (spec[key] !== undefined) {
          project[key] = spec[key];
        }
      });
      project.updated = new Date();
      // Only determine type/subtypes/processor for local path
      if (spec.repoPath && !spec.repoUrl) {
        project.projectTypes = await this.detectProjectTypes(project);        
        const processors = await this.detectProjectProcessors(project);
        if (processors && processors.length > 0) {
          project.processors = processors;
        }
      }
      await this.updateProject(project._id, project);
      return project;
    };

    // Helper to create a new project
    const createNewProject = async (spec: Partial<IReactorProject>) => {
      const now = new Date();
      return this.createProject({
        ...spec,
        name: spec.name || (spec.repoPath ? spec.repoPath.split('/').pop() : undefined),
        fqn: `${spec.nameSpace}.${spec.name || (spec.repoPath ? spec.repoPath.split('/').pop() : '')}@${spec.version || 'unknown'}`,
        created: now,
        updated: now
      });
    };

    let project: Partial<IReactorProject> = null;
    // Prefer repoPath for lookup, else repoUrl
    const lookupKey = projectSpec.repoPath || projectSpec.repoUrl;
    project = await this.getProject(lookupKey);

    if (project) {
      project = await updateProjectFields(project, projectSpec);
    } else {
      project = await createNewProject(projectSpec);
    }

    return project;
  }


 async determineProjectType(project: Partial<IReactorProject>): Promise<KnownReactorProjectTypes[]> {
  return this.detectProjectTypes(project);
 }

  
  async getProjectForCatalogNode(node: any): Promise<Partial<IReactorProject>> {
    if (!node || !node.id) return null;
    return ReactorProjectModel.findOne({ _id: node.id }).lean();
  }

  async sync(project: IReactorProject): Promise<IReactorProject> {
    // Stub: Implement sync logic as needed
    return project;
  }

  async index(project: IReactorProject): Promise<IReactorProject> {
    // Stub: Implement index logic as needed
    return project;
  }

  async getAttributes(node: any): Promise<ReactorNodeAttributes[]> {
    // Stub: Implement attribute retrieval as needed
    return [];
  }
}

export default ReactorProjectServiceImpl;
