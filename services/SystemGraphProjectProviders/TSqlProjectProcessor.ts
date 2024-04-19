import fs from "fs";
import path from "path";
import { default as ApiError } from "@reactory/server-core/exceptions";
import {
  IReactorProject,
  IReactorProjectFileSpec,
  IProjectProcessor,
  ISystemGraphManager,
  AttributeProvider,
  ReactorNodeAttributes,
  IProjectNodeProvider,
} from "@reactory/server-modules/reactor/types/service.types";

import Hash from "@reactory/server-core/utils/hash";
import {
  ReactorDataNode,
  ReactorNode,
  ReactorNodeType,
} from "@reactory/server-modules/reactor/types/model.types";
import { ObjectId } from "mongodb";

import SVGS from "@reactory/server-modules/reactor/data/reactor-svgs";
import { PagingRequest } from "database/types";

import { getReactorProjectCatalogs } from "@reactory/server-modules/reactor/data/index";
import Cache from "@reactory/server-modules/core/models/CoreCache";
import { profileEnd } from "console";


class TSqlProjectProcessor
  implements IProjectProcessor, AttributeProvider, IProjectNodeProvider
{
  props: Reactory.Service.IReactoryServiceProps;
  context: Reactory.Server.IReactoryContext;

  fileService: Reactory.Service.IReactoryFileService;
  fetchService: Reactory.Service.IFetchService;
  searchService: Reactory.Service.ISearchService;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.props = props;
    this.context = context;    
  }
  /**
   *
   * @param project
   * @returns
   */
  async getProjectNode(
    project: IReactorProject
  ): Promise<Partial<ReactorDataNode<IReactorProject>>> {
    const cachedNode = await this.context.getValue<
      Partial<ReactorDataNode<IReactorProject>>
    >(`REACTOR_NODE_${project.id}`);
    if (cachedNode) return cachedNode;

    const projectNode: Partial<ReactorDataNode<IReactorProject>> = {
      id: project.id,
      index: Hash(project.id),
      name: project.name,
      key: `${project.id}`,
      version: project.version,
      nameSpace: project.nameSpace,
      providerId: project.providerId,
      source: project.source,
      parent: null,
      type: ReactorNodeType.DATASTORE,
      categories: [],
      description: project.description,
      children: [],
      inputs: [],
      outputs: [],
      metrics: [],
      created: new Date(),
      updated: new Date(),
      data: project,
    };

    this.context.setValue(`REACTOR_NODE_${project.id}`, projectNode);

    return Promise.resolve(projectNode);
  }

  async getChildrenForNode(
    node: ReactorNode,
    treeKey: string,
    filter: string,
    paging: PagingRequest
  ): Promise<ReactorNode[]> {
    const children: ReactorNode[] = [];
    let root: ReactorNode;
    let project: Partial<IReactorProject>;
    const that = this;

    // use the node key, to determine the root id
    // of the project
    const rootId = node.key.indexOf("|")
      ? node.key.split("|").shift()
      : node.key;
    const projectCatalogs = await getReactorProjectCatalogs(this.context);

    if (node.id === parseInt(rootId)) {
      project = node.data as IReactorProject;
    } else {
      project = projectCatalogs.find(
        (project) => project.id === parseInt(rootId)
      );
    }

    // this id will be used for id generations.

    if (node.type === "DATASTORE") {
      if (project && project.pathSpecs) {
        // use the path specs to create the child nodes
        const folderPromises = project.pathSpecs.map(async (pathSpec) => {
          let id: number = Hash(`${node.id}_${pathSpec.path}`);
          // check cache for the node
          let _node = null;

          //count the number of files in the folder
          const fullpath = path.join(project.source, pathSpec.path);
          let data = {};

          if (fs.existsSync(fullpath)) {
            // list files that match the filter in the path
            let files = fs.readdirSync(fullpath);
            if (filter) {
              files = files.filter((file) => file.match(filter));
            }
            data = {
              fileCount: files.length,
              path: fullpath,
              pathSpec,              
            };
          }
          _node = {
            id,
            index: id,
            name: pathSpec.path,
            type: ReactorNodeType.FOLDER,
            description: `Folder ${pathSpec.path}`,
            children: [],
            inputs: [],
            outputs: [],
            metrics: [],
            providerId: node.providerId,
            parentId: node.id,
            created: new Date(),
            updated: new Date(),
            data: {},
            key: `${node.key}|${id}`,
            nameSpace: node.nameSpace,
            version: node.version,
            data,
          };

          that.context.setValue(`REACTOR_NODE_${id}`, _node);

          return _node;
        });

        const allFoldersResults = await Promise.all(folderPromises);
        allFoldersResults.forEach((folder: any) => {
          if (folder && folder.id) children.push(folder);
        });
      }

      let id = Hash(`${node.id}_connections`);
      let _node: ReactorDataNode<any> = {
        id,
        index: id,
        name: "Connections",
        type: ReactorNodeType.CONNECTION,
        description: "Container for configuring connections to the database",
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        providerId: node.providerId,
        created: new Date(),
        updated: new Date(),
        data: {},
        key: `${node.key}|${id}`,
        nameSpace: node.nameSpace,
        version: node.version,
      };
      

      children.push(_node);
      that.context.setValue(`REACTOR_NODE_${id}`, _node);
    }

    if (node.type === "FOLDER") {
      // get the children for the folder
      const { context } = this;
      const { warn, info, error } = context;
      // get the folder using the node.name as the folder name.
      // we use the key to get the folder path and root project

      // check the chache for the node
      const cachedNode = await that.context.getValue<ReactorDataNode<any>>(`REACTOR_NODE_${node.id}`);
      let fullpath = "";
      if(cachedNode && cachedNode.data) {
        fullpath = cachedNode.data.path;
      } else {
        if (!project) {
          error(`No project found for ${node.id}`);
          throw new ApiError(`No project found for ${node.id}`, 500);
        }

        fullpath = path.join(project.source, node.name);
      }

      if (fs.existsSync(fullpath)) {
        // list files that match the filter in the path
        let files = fs.readdirSync(fullpath);
        if (filter) {
          files = files.filter((file) => file.match(filter));
        }
        // add the files to the project
        files.forEach((file) => {
          let id = Hash(`${node.id}_${file}`);
          let _node: ReactorDataNode<any> = {
            id,
            index: id,
            name: file,
            type: ReactorNodeType.FILE,
            description: `File ${file}`,
            children: [],
            inputs: [],
            outputs: [],
            metrics: [],
            providerId: node.providerId,
            created: new Date(),
            updated: new Date(),
            data: {
              path: path.join(fullpath, file),
              name: file,
              type: "file",
            },
            key: `${node.key}|${id}`,
            nameSpace: node.nameSpace,
            version: node.version,
          };
          children.push(_node);
          that.context.setValue(`REACTOR_NODE_${id}`, _node);
        });
      }
    }

    return Promise.resolve(children);
  }

  sync(project: IReactorProject): Promise<IReactorProject> {
    throw new Error("Method not implemented.");
  }
  index(project: IReactorProject): Promise<IReactorProject> {
    throw new Error("Method not implemented.");
  }

  getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    const attributes: ReactorNodeAttributes[] = [];

    if (node.type === "DATASTORE" && SVGS["tsql"]) {
      attributes.push({
        id: Hash(`${node.id}_project-icon`),
        key: "icon",
        value: {
          type: "svg",
          svg: SVGS["tsql"],
        },
      });

      attributes.push({
        id: Hash(`${node.id}_project_link`),
        key: "menu-project-link",
        value: {
          link: "https://github.com/Worldremit/wr-database",
          icon: "file_open",
          title: "GitHub",
        },
      });

      attributes.push({
        id: Hash(`${node.id}_menu-form-edit`),
        key: "menu-form-edit",
        value: {
          formId: "reactor.TSqlProjectForm@1.0.0",
          formProps: {
            id: node.id,
          },
          icon: "edit",
          title: "Edit Project",
        },
      });

      attributes.push({
        id: Hash(`${node.id}_menu-form-statistics`),
        key: "menu-form-statistics",
        value: {
          formId: "reactor.TSqlProjectStatisicsForm@1.0.0",
          formProps: {
            id: node.id,
          },
          icon: "monitoring",
          title: "Project Stats",
        },
      });

      // add attribute for index button
      attributes.push({
        id: Hash(`${node.id}_menu-index`),
        key: "menu-index",
        value: {
          formId: "reactor.ProjectIndexForm@1.0.0",
          formProps: {
            id: node.id,
          },
          icon: "location_searching",
          title: "Index Project",
        },
      });

      // add attribute for index button
      attributes.push({
        id: Hash(`${node.id}_menu-crawl`),
        key: "menu-crawl",
        value: {
          formId: "reactor.ProjectCrawlForm@1.0.0",
          formProps: {
            id: node.id,
          },
          icon: "travel_explore",
          title: "Crawl Project",
        },
      });
    }

    if (node.type === "CHILD") {
    }

    return Promise.resolve(attributes);
  }

  getFileSpecs(project: IReactorProject): Partial<IReactorProjectFileSpec>[] {
    const { context } = this;
    const { warn, info, error } = context;

    let fileSpecs: IReactorProjectFileSpec[] = [];

    if (!project.pathSpecs) {
      error(`No path specs found for project ${project.name}`);
      throw new ApiError(
        `No path specs found for project ${project.name}`,
        500
      );
    }

    project.pathSpecs.forEach((pathSpec) => {
      const fullpath = path.join(project.source, pathSpec.path);
      if (fs.existsSync(fullpath)) {
        // list files that match the filter in the path
        let files = fs.readdirSync(fullpath);
        if (pathSpec.filter) {
          files = files.filter((file) => file.match(pathSpec.filter));
        }
        // add the files to the project
        files.forEach((file) => {
          fileSpecs.push({
            id: Hash(`${pathSpec.path}-${file}-${pathSpec.type}`),
            type: pathSpec.type,
            path: path.join(fullpath, file),
            content: "<NOTREAD>",
          });
        });
      } else {
        warn(`Path ${fullpath} does not exist`);
      }
    });

    return fileSpecs;
  }

  process(project: IReactorProject): Reactory.Models.ISearchable[] {
    const { context } = this;
    const { warn, info, error } = context;
    let nextProject = { ...project };
    if (!nextProject.files) nextProject.files = [];
    const { pathSpecs } = nextProject;

    nextProject.files = this.getFileSpecs(nextProject);

    if (!nextProject.files) {
      error(`No files found for project ${project.name}`);
      throw new ApiError(`No files found for project ${project.name}`, 500);
    }

    // for each of the files, we need to read the contents and create a searchable
    const { files } = nextProject;
    const searchable: Reactory.Models.ISearchable[] = [];
    files.forEach((file) => {
      const fileContents = fs.readFileSync(file.path, "utf-8");
      const lines = fileContents.split("\n");

      const idString = `${project.nameSpace}.${project.name}_${
        file.type
      }_${file.path.split(path.sep).pop()}`;

      searchable.push({
        id: Hash(idString),
        name: `${file.type}_${file.path.split(path.sep).pop()}`,
        nameSpace: project.nameSpace,
        version: project.version,
        source: fileContents,
        path: file.path,
        metrics: [
          {
            unit: "lines",
            value: lines.length,
            name: "Line Count",
          },
        ],
        type: {
          id: file.type,
          name: file.type,
        },
      });
    });

    return searchable;
  }

  onStartup(): Promise<void> {
    return Promise.resolve();
  }

  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;
  toString?(includeVersion?: boolean): string {
    throw new Error("Method not implemented.");
  }

  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }
  setExecutionContext(
    executionContext: Reactory.Server.IReactoryContext
  ): void {
    this.context = executionContext;
  }

  setFileService(fileService: Reactory.Service.IReactoryFileService): void {
    this.fileService = fileService;
  }

  setFetchService(fetchService: Reactory.Service.IFetchService): void {
    this.fetchService = fetchService;
  }

  setReactorySearchService(
    searchService: Reactory.Service.ISearchService
  ): void {
    this.searchService = searchService;
  }

  static reactory: Reactory.Service.IReactoryServiceDefinition<TSqlProjectProcessor> =
    {
      name: "TSqlProjectProcessor",
      nameSpace: "reactor",
      version: "1.0.0",
      description:
        "Service for catalogging and creating a graph for a given system",
      id: "reactor.TSqlProjectProcessor@1.0.0",
      serviceType: "data",
      service(
        props: Reactory.Service.IReactoryServiceProps,
        context: Reactory.Server.IReactoryContext
      ) {
        return new TSqlProjectProcessor(props, context);
      },
      dependencies: [
        { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
        { id: "core.FetchService@1.0.0", alias: "fetchService" },
        { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
      ],
    };
}

export default TSqlProjectProcessor.reactory;
