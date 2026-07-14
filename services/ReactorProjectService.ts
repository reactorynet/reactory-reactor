import Reactory from "@reactorynet/reactory-core";
import fs from "fs";
import path from "path";
import { ObjectId } from "mongodb";
import {
  ReactorProjectService,
  IReactorProject,
  PageReactorProjectResult,
  ReactorNodeAttributes,
  KnownReactorProjectTypes,
  IProjectProcessor,
  IProjectProcessorConfig,
  ReactorProjectDocumentation,
  PagedFilter,
  IReactorProjectMetrics,
} from "../types/service.types";
import {
  PagingRequest,
  PagingResult,
} from "@reactory/server-core/database/types";
import { ReactorProjectModel } from "../models/ReactorProject";
import { service } from "@reactory/server-core/application/decorators";
import {
  JavaProjectProcessor,
  TSqlProjectProcessor,
  CSharpProjectProcessor,
  NodeJSProjectProcessor,
  ReactNativeProjectProcessor,
  PythonProjectProcessor,
  BackStageProjectProcessor,
} from "./SystemGraphProjectProviders";
import logger from "@reactory/server-core/logging";

@service({
  id: "reactor.ReactorProjectService@1.0.0",
  name: "ReactorProjectService",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for CRUD operations on Reactor Projects",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryWorkflowService@1.0.0", alias: "workflowService" },
  ],
})
class ReactorProjectServiceImpl implements ReactorProjectService {
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;
  nameSpace = "reactor";
  name = "ReactorProjectService";
  version = "1.0.0";

  private processors: Record<string, IProjectProcessor> = {};
  private workflowService: Reactory.Service.IReactoryWorkflowService;
  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.props = props;
    this.context = context;
    // configure processors
    this.processors["java"] = new JavaProjectProcessor(props, context);
    this.processors["tsql"] = new TSqlProjectProcessor(props, context);
    this.processors["csharp"] = new CSharpProjectProcessor(props, context);
    this.processors["nodejs"] = new NodeJSProjectProcessor(props, context);
    this.processors["reactnative"] = new ReactNativeProjectProcessor(
      props,
      context
    );
    this.processors["python"] = new PythonProjectProcessor(props, context);
    this.processors["backstage"] = new BackStageProjectProcessor(
      props,
      context
    );
  }

  setWorkflowService(
    workflowService: Reactory.Service.IReactoryWorkflowService
  ) {
    this.workflowService = workflowService;
  }

  getRepoUrl(project: Partial<IReactorProject>): string {
    if (project.repoUrl) {
      return project.repoUrl;
    }
    // Default to a GitHub URL based on nameSpace and name
    return `https://github.com/${project.nameSpace}/${project.name}.git`;
  }

  async getPrimaryDocumentation(
    project: Partial<IReactorProject>
  ): Promise<ReactorProjectDocumentation> {
    // check if the project has properties for primary documentation
    if (project.primaryDocumentation) {
      return {
        id:
          project.primaryDocumentation.id ||
          this.context.utils.hash(project._id.toString()),
        title: project.primaryDocumentation.title || "Primary Documentation",
        url: project.primaryDocumentation.url || "",
        format: project.primaryDocumentation.format || "markdown",
        content: project.primaryDocumentation.content || "",
        created: project.primaryDocumentation.created || new Date(),
        createdBy: project.primaryDocumentation.createdBy || this.context.user,
      };
    }

    if (project.repoPath) {
      // check if project has a repoPath
      // check in the following order for a readme file:
      // 1. README.md
      // 2. README.txt
      // 3. README
      // 4. docs/README.md
      // 5. docs/index.md
      // 6. index.md
      // 7. docs/README.txt
      // 8. docs/index.txt
      // 9. index.txt
      const readmeFiles = [
        "README.md",
        "README.txt",
        "README",
        "docs/README.md",
        "docs/index.md",
        "index.md",
        "docs/README.txt",
        "docs/index.txt",
        "index.txt",
      ];

      for (const file of readmeFiles) {
        const filePath = `${project.repoPath}/${file}`;
        try {
          const content = fs.readFileSync(filePath, "utf8");
          return {
            id: this.context.utils.hash(filePath),
            title: `Source: ${project.name || project.repoPath}`,
            path: filePath,
            format: file.endsWith(".md") ? "markdown" : "text",
            content,
            created: new Date(),
            createdBy: null,
          };
        } catch {
          // ignore errors, continue to next file
        }
      }
    }

    return null;
  }

  async getAdditionalDocumentation(
    project: Partial<IReactorProject>
  ): Promise<ReactorProjectDocumentation[]> {
    // check if the project has secondary documentation
    if (
      project.secondaryDocumentation &&
      Array.isArray(project.secondaryDocumentation)
    ) {
      return project.secondaryDocumentation.map((doc) => ({
        id: doc.id || this.context.utils.hash(doc.url),
        title: doc.title || "Secondary Documentation",
        url: doc.url || "",
        format: doc.format || "markdown",
        content: doc.content || "",
        created: doc.created || new Date(),
        createdBy: doc.createdBy,
      }));
    }

    if (project.repoPath) {      
      const readmeFiles = [
        "*.md",
        "*.txt",
        "*.pdf",
        "*.docx",
        "*.doc",
        "*.xls",
        "*.xlsx",
        "*.ppt",
        "*.pptx",
        "*.csv",
      ];

      let autoGeneratedDocs: ReactorProjectDocumentation[] = [];

      const getFormat = (file: string) => {
        switch (file.split(".").pop()) {
          case "md":
            return "markdown";
          case "txt":
            return "text";
          case "pdf":
            return "pdf";
          case "docx":
            return "docx";
          case "doc":
            return "doc";
          case "xls":
            return "xls";
          case "xlsx":
            return "xlsx";
          case "ppt":
            return "ppt";
          default:
            return "text";
        }
      };

      // look for any files in the repoPath that match the readmeFiles
      const files = fs.readdirSync(project.repoPath);
      for (const file of files) {
        if (readmeFiles.some(rf => file.endsWith(rf))) {
          const filePath = `${project.repoPath}/${file}`;
          const content = fs.readFileSync(filePath, "utf8");
          autoGeneratedDocs.push({
            id: this.context.utils.hash(filePath),
            title: `Source: ${project.name || project.repoPath}`,
            path: filePath,
            url: path.join(project.repoUrl, file),
            format: getFormat(file),
            content,
            created: new Date(),
            createdBy: null,
          });
        }
      }
    }

    return [];
  }

  async detectProjectTypes(
    project: Partial<IReactorProject>
  ): Promise<KnownReactorProjectTypes[]> {
    // Check if the project has a processor that supports it
    let projectTypes: KnownReactorProjectTypes[] = [];
    const { context } = this;
    //Iterate through processors to find a match
    for (const processor of Object.values(this.processors)) {
      if (processor.supportsProject(project)) {
        // check if the processor has a getProjectTypes method
        if (typeof processor.getProjectTypes === "function") {
          const types = processor.getProjectTypes(
            project
          ) as KnownReactorProjectTypes[];
          if (types && types.length > 0) {
            projectTypes = [...projectTypes, ...types];
          }
        } else {
          // log a warning if the processor does not implement getProjectTypes
          context.warn(
            `Processor ${processor.name} does not implement getProjectTypes method`
          );
        }
      }
    }
    return projectTypes;
  }

  async detectProjectProcessors(
    project: Partial<IReactorProject>
  ): Promise<IProjectProcessorConfig[]> {
    // Check if the project has a processor that supports it
    let processors: IProjectProcessorConfig[] = [];

    // If not, iterate through processors to find a match
    for (const processorKey of Object.keys(this.processors)) {
      const processor = this.processors[processorKey];
      if (processor.supportsProject(project)) {
        const fqn = `${processor.nameSpace}.${processor.name}@${processor.version}`;
        processors.push({
          id: processorKey,
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

  async getProjects(filter?: Partial<PagedFilter>): Promise<PageReactorProjectResult> {
    let query: any = filter?.comparitor || {};
    const search = filter?.search || "";
    const page = filter?.paging?.page || 1;
    const pageSize = filter?.paging?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    // If search string is specified, add a case-insensitive regex to the query for project name
    if (search && search.trim().length > 0) {
      query = {
        ...query,
        name: { $regex: search, $options: "i" } as any,
      };
    }
    if (filter?.businessUnit && ObjectId.isValid(filter.businessUnit)) {
      query = {
        ...query,
        businessUnit: new ObjectId(filter.businessUnit) as any,
      };
    }
    if (filter?.ownerTeam && ObjectId.isValid(filter.ownerTeam)) {
      query = {
        ...query,
        ownerTeam: new ObjectId(filter.ownerTeam) as any,
      };
    }
    if (filter?.owner && ObjectId.isValid(filter.owner)) {
      query = {
        ...query,
        owner: new ObjectId(filter.owner) as any,
      };
    }
    if (filter?.system && ObjectId.isValid(filter.system)) {
      query = {
        ...query,
        system: new ObjectId(filter.system) as any,
      };
    }
    if (filter?.status) {
      query = {
        ...query,
        status: filter.status,
      };
    }

    const total = await ReactorProjectModel.countDocuments(query);
    const projectsRaw = await ReactorProjectModel.find(query, {
      _id: 1,
      fqn: 1,
      name: 1,
      nameSpace: 1,
      version: 1,
      repoPath: 1,
      repoUrl: 1,
      projectTypes: 1,
      lastSync: 1,
      description: 1,
      tasksUrl: 1,
      primaryDocumentation: 1,
      secondaryDocumentation: 1,
      primarySlackChannel: 1,
      secondarySlackChannels: 1,
      dependencies: 1,
      pathSpecs: 1,
      files: 1,
      deployments: 1,
      dashboards: 1,
      processor: 1,
      processorOptions: 1,
      processors: 1,
      ownerTeam: 1,
      teams: 1,
      engineers: 1,
      activeBranch: 1,
      mainBranch: 1,
      branches: 1,
      tags: 1,
    }, {
      populate: ['businessUnit', 'organization', 'ownerTeam', 'owner'],
    })
      .skip(skip)
      .limit(pageSize)
      .lean();
    const projects: Partial<IReactorProject>[] = projectsRaw.map((p: any) => ({
      ...p,
      id: p._id.toString(),
    }));

    return {
      projects,
      paging: {
        total,
        page,
        pageSize,
        hasNext: skip + projects.length < total,
      },
    };
  }

  async getProject(idOrPath: string): Promise<Partial<IReactorProject>> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = {
        $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }],
      };
    }
    return ReactorProjectModel.findOne(query, {
      _id: 1,
      fqn: 1,
      name: 1,
      nameSpace: 1,
      version: 1,
      repoPath: 1,
      repoUrl: 1,
      projectTypes: 1,
      lastSync: 1,
      description: 1,
      tasksUrl: 1,
      primaryDocumentation: 1,
      secondaryDocumentation: 1,
      primarySlackChannel: 1,
      secondarySlackChannels: 1,
      dependencies: 1,
      pathSpecs: 1,
      files: 1,
      deployments: 1,
      dashboards: 1,
      processor: 1,
      processorOptions: 1,
      processors: 1,
      ownerTeam: 1,
      teams: 1,
      engineers: 1,
      activeBranch: 1,
      mainBranch: 1,
      branches: 1,
      tags: 1,
    }, {
      populate: [
        'businessUnit', 
        'organization', 
        'ownerTeam',
        'teams'
      ],
    }).lean();
  }

  async createProject(
    project: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    try {
      // check if the organization and business unit are set
      // if they are we check if they have an id, if not we
      // perform a lookup to see if the business unit and organization
      // exists, if not we create them.
      const organizationService =
        this.context.getService<Reactory.Service.IReactoryOrganizationService>(
          "core.OrganizationService@1.0.0"
        );
      try {
        if (project.organization && !project.organization._id) {
          // check if there is a name set for the organization
          if (project.organization?.name) {
            const org = await organizationService.findWithName(
              project.organization.name
            );
            if (org) {
              project.organization = org;
            } else {
              project.organization = await organizationService.create(
                project.organization.name
              );
            }
          } else {
            throw new Error(
              "Organization name is required to create a project"
            );
          }
        }
      } catch (organizationError) {
        logger.error(
          `Error processing organization for project ${project.name}: ${organizationError.message}`
        );
        throw new Error(
          `Failed to process organization for project ${project.name}: ${organizationError.message}`
        );
      }

      try {
        if (project.businessUnit && !project.businessUnit?._id) {
          // check if there is a name set for the business unit
          if (
            project.businessUnit &&
            (project.businessUnit as Reactory.Models.IBusinessUnit).name
          ) {
            const businessUnit = await organizationService.findBusinessUnit(
              project.organization._id as ObjectId,
              (project.businessUnit as Reactory.Models.IBusinessUnit).name
            );
            if (businessUnit) {
              project.businessUnit = businessUnit;
            } else {
              project.businessUnit =
                await organizationService.createBusinessUnit(
                  project.organization._id as ObjectId,
                  (project.businessUnit as Reactory.Models.IBusinessUnit).name
                );
            }
          } else {
            throw new Error(
              "Business Unit name is required to create a project"
            );
          }
        }
      } catch (businessUnitError) {
        logger.error(
          `Error processing business unit for project ${project.name}: ${businessUnitError.message}`
        );
        throw new Error(
          `Failed to process business unit for project ${project.name}: ${businessUnitError.message}`
        );
      }

      try {
        if (project.ownerTeam && !(project.ownerTeam as any)?._id) {
          // check if there is a name set for the owner team
          if (project.ownerTeam?.name) {
            const team = await organizationService.findTeam(
              project.organization._id as ObjectId,
              project.ownerTeam.name
            );
            if (team) {
              project.ownerTeam = team;
            } else {
              project.ownerTeam = await organizationService.createTeam(
                project.organization._id as ObjectId,
                project.ownerTeam.name
              );
            }
          } else {
            throw new Error("Owner Team name is required to create a project");
          }
        }
      } catch (ownerTeamError) {
        logger.error(
          `Error processing owner team for project ${project.name}: ${ownerTeamError.message}`
        );
        throw new Error(
          `Failed to process owner team for project ${project.name}: ${ownerTeamError.message}`
        );
      }

      const created = await ReactorProjectModel.create(project);
      // Return a plain object (mirroring getProject/updateProject which use
      // .lean()). A raw Mongoose document loses all of its fields when spread
      // ({ ...doc }), which the processing pipeline does — leaving name,
      // repoPath, etc. undefined and producing an empty graph.
      const plain = created.toObject() as Partial<IReactorProject>;
      plain.id = created._id?.toString();
      return plain;
    } catch (error) {
      logger.error(`Error creating project: ${error.message}`);
      throw new Error(`Failed to create project: ${error.message}`);
    }
  }

  async updateProject(
    idOrPath: string,
    updates: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = {
        $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }],
      };
    }
    const updated = await ReactorProjectModel.findOneAndUpdate(query, updates, {
      new: true,
    }).lean();
    return updated as Partial<IReactorProject>;
  }

  async deleteProject(idOrPath: string): Promise<boolean> {
    let query: any = {};
    if (ObjectId.isValid(idOrPath)) {
      query = { _id: new ObjectId(idOrPath) };
    } else {
      query = {
        $or: [{ fqn: idOrPath }, { name: idOrPath }, { repoPath: idOrPath }],
      };
    }
    const result = await ReactorProjectModel.deleteOne(query);
    return result.deletedCount > 0;
  }

  async catalogProject(
    projectSpec: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    if (!projectSpec.repoPath && !projectSpec.repoUrl) {
      throw new Error(
        "Project must have a repoPath or repoUrl to be cataloged"
      );
    }

    // Helper to update an existing project
    const updateProjectFields = async (
      project: Partial<IReactorProject>,
      spec: Partial<IReactorProject>
    ) => {
      Object.keys(spec).forEach((key) => {
        if (spec[key] !== undefined) {
          project[key] = spec[key];
        }
      });

      const organizationService =
        this.context.getService<Reactory.Service.IReactoryOrganizationService>(
          "core.OrganizationService@1.0.0"
        );

      try {
        // validate the lookup / referenced fields that they have are set correctly.
        if (spec.organization && spec.organization.name) {
          const org = await organizationService.findWithName(
            spec.organization.name
          );
          if (org) {
            project.organization = org;
          } else {
            project.organization = await organizationService.create(
              spec.organization.name
            );
          }
        } else {
          delete spec.organization; // Remove organization if not set
        }
      } catch (organizationError) {
        logger.error(
          `Error processing organization for project ${project.name}: ${organizationError.message}`
        );
        throw new Error(
          `Failed to process organization for project ${project.name}: ${organizationError.message}`
        );
      }

      try {
        if (spec.ownerTeam && spec.ownerTeam.name) {
          const team = await organizationService.findTeam(
            project?.organization._id as ObjectId,
            spec.ownerTeam.name
          );
          if (team) {
            project.ownerTeam = team;
          } else {
            project.ownerTeam = await organizationService.createTeam(
              project.organization._id as ObjectId,
              spec.ownerTeam.name
            );
          }
        } else {
          delete spec.ownerTeam; // Remove ownerTeam if not set
        }
      } catch (ownerTeamError) {
        logger.error(
          `Error processing owner team for project ${project.name}: ${ownerTeamError.message}`
        );
        throw new Error(
          `Failed to process owner team for project ${project.name}: ${ownerTeamError.message}`
        );
      }

      try {
        if (
          spec.businessUnit &&
          (spec.businessUnit as Reactory.Models.IBusinessUnit).name
        ) {
          const businessUnit = await organizationService.findBusinessUnit(
            project.organization._id as ObjectId,
            (spec.businessUnit as Reactory.Models.IBusinessUnit).name
          );
          if (businessUnit) {
            project.businessUnit = businessUnit;
          } else {
            project.businessUnit = await organizationService.createBusinessUnit(
              project.organization._id as ObjectId,
              (spec.businessUnit as Reactory.Models.IBusinessUnit).name
            );
          }
        } else {
          delete spec.businessUnit; // Remove businessUnit if not set
        }
      } catch (businessUnitError) {
        logger.error(
          `Error processing business unit for project ${project.name}: ${businessUnitError.message}`
        );        
      }

      project.updated = new Date();
      // Only determine type/subtypes/processor for local path
      if (spec.repoPath && !spec.repoUrl) {
        project.projectTypes = await this.detectProjectTypes(project);
        const processors = await this.detectProjectProcessors(project);
        if (processors && processors.length > 0) {
          project.processors = processors;
        }
      }
      return project;
    };

    // Helper to create a new project
    const createNewProject = async (spec: Partial<IReactorProject>) => {
      const now = new Date();
      return this.createProject({
        ...spec,
        name:
          spec.name ||
          (spec.repoPath ? spec.repoPath.split("/").pop() : undefined),
        fqn: `${spec.nameSpace}.${
          spec.name || (spec.repoPath ? spec.repoPath.split("/").pop() : "")
        }@${spec.version || "unknown"}`,
        created: now,
        updated: now,
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
      // New projects go straight to processing; detect their type/processors
      // here (updateProjectFields already does this for existing projects).
      if (project.repoPath && !project.repoUrl) {
        project.projectTypes = await this.detectProjectTypes(project);
        const processors = await this.detectProjectProcessors(project);
        if (processors && processors.length > 0) {
          project.processors = processors;
        }
      }
    }

    // Process the project with all applicable processors
    project = await this.processProject(project);
    project.lastSync = new Date();
    // Persist the processed project. Strip immutable / derived identity fields
    // from the update payload so Mongo does not reject the write, and await the
    // result so any failure is caught here rather than surfacing as an opaque
    // rejection to the caller.
    const projectId = `${project._id || project.id}`;
    try {
      const { _id, id, ...updates } = project as Partial<IReactorProject> & {
        _id?: any;
        id?: any;
      };
      const saved = await this.updateProject(projectId, updates);
      return saved || project;
    } catch (error) {
      this.context.error(
        `Error saving processed project ${project.name} (${projectId}): ${error.message}\n${error.stack || ""}`
      );
      return project; // Return the project even if the final save fails
    }
  }
  /**
   * Function checks all the processors for the project and runs the
   * process method for each processor that supports the project.
   * @param project
   */
  async processProject(
    project: Partial<IReactorProject>
  ): Promise<Partial<IReactorProject>> {
    if (!project || !project.repoPath) {
      throw new Error("Project must have a repoPath to be processed");
    }

    if (!project.processors || project.processors.length === 0) {
      // If no processors are defined, detect them
      project.processors = await this.detectProjectProcessors(project);
    }

    if (!project.processors || project.processors.length === 0) {
      return project; // No processors to run
    }

    // Iterate through each processor and run its process method
    for (const processorConfig of project.processors) {
      const processor = this.processors[processorConfig.id];
      if (processor && typeof processor.process === "function") {
        try {
          const nextProject = await processor.process(project);
          if (nextProject) {
            project = { ...project, ...nextProject };
          }
        } catch (error) {
          this.context.error(
            `Error processing project with ${processor.name}: ${error.message}`
          );
        }
      } else {
        this.context.warn(
          `Processor ${processorConfig.processor} not found or does not implement process method`
        );
      }
    }

    return project;
  }

  async determineProjectType(
    project: Partial<IReactorProject>
  ): Promise<KnownReactorProjectTypes[]> {
    return this.detectProjectTypes(project);
  }

  async getProjectForCatalogNode(node: any): Promise<Partial<IReactorProject>> {
    if (!node || !node.id) return null;
    return ReactorProjectModel.findOne({ _id: node.id }).lean();
  }

  async sync(project: IReactorProject): Promise<IReactorProject> {
    // Re-run processing (which persists nodes/edges and indexes searchables)
    // and stamp the sync time.
    const processed = (await this.processProject(project)) as IReactorProject;
    processed.lastSync = new Date();
    if (processed._id || processed.id) {
      await this.updateProject(`${processed._id || processed.id}`, {
        lastSync: processed.lastSync,
      });
    }
    return processed;
  }

  async index(project: IReactorProject): Promise<IReactorProject> {
    // Indexing == running the processors' process() pipeline, which builds and
    // persists the graph nodes/edges and writes searchables to the index.
    return (await this.processProject(project)) as IReactorProject;
  }

  async getAttributes(node: any): Promise<ReactorNodeAttributes[]> {
    // Stub: Implement attribute retrieval as needed
    return [];
  }

  

  async calculateProjectMetrics(project: Partial<IReactorProject>, startDate?: Date, endDate?: Date): Promise<IReactorProjectMetrics[]> { 
    
    const DEFAULT_METRICS: IReactorProjectMetrics = {
      date: new Date(),
      incidents: 0,
      errors: 0,
      deployments: 0,
      activeDeployments: 0,
      openPullRequests: 0,
      closedPullRequests: 0,
      activeBranches: 0,
      closedTasks: 0,
      openedTasks: 0,
      totalBranches: 0,      
      totalTeams: 0,
      activeTasks: 0,
      totalEngineers: 0,
    }

    if (!project) return [DEFAULT_METRICS];
    
    // TODO: Implement actual metrics calculation
    return [DEFAULT_METRICS];
  }
      

  async getProjectMetrics(project: Partial<IReactorProject>, startDate?: Date, endDate?: Date): Promise<IReactorProjectMetrics[]> {
    // if the project is null, we return metrics for all projects.
    if (!project) {
      // get all projects
      const projects = await ReactorProjectModel.find({}).lean();
      // get metrics for all projects
      const metrics = await this.calculateProjectMetrics(projects, startDate, endDate);
      return metrics;
    } else {
      // get metrics for the project
      const metrics = await this.calculateProjectMetrics(project, startDate, endDate);
      return metrics;
    }    
  }
}

export default ReactorProjectServiceImpl;
