import fs from "fs";
import {
  IReactorProject,
  ReactorNodeAttributes,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import Hash from "@reactory/server-core/utils/hash";
import {
  ReactorNode,
  ReactorNodeType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import { PagingRequest } from "@reactory/server-core/database/types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor from "../BaseProjectProcessor";
import { appendAncestry } from "../../graph/GraphIdentity";

@service({
  name: "TSqlProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for T-SQL database projects (.sqlproj, .dacpac)",
  id: "reactor.TSqlProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class TSqlProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "TSqlProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "tsql";
  }

  protected rootNodeType(): ReactorNodeType {
    return ReactorNodeType.DATASTORE;
  }

  /**
   * The generic walker gives us folders (Tables/Views/Stored Procedures/…) and
   * files for free. We additionally surface a synthetic "Connections" node at
   * the datastore root for configuring database connectivity.
   */
  async getChildrenForNode(
    node: Partial<ReactorNode>,
    treeKey: string,
    filter: string,
    paging: PagingRequest
  ): Promise<ReactorNode[]> {
    const children = await super.getChildrenForNode(node, treeKey, filter, paging);

    const isRoot = node.parentId === undefined || node.parentId === null;
    if (isRoot && node.type === ReactorNodeType.DATASTORE) {
      const id = Hash(`${node.id}_connections`);
      const connections: ReactorNode = {
        id,
        index: id,
        name: "Connections",
        type: ReactorNodeType.CONNECTION,
        description: "Container for configuring connections to the database",
        parentId: node.id,
        providerId: node.providerId,
        nameSpace: node.nameSpace,
        version: node.version,
        key: appendAncestry(node.key, id),
        categories: [],
        children: [],
        inputs: [],
        outputs: [],
        metrics: [],
        created: new Date(),
        updated: new Date(),
        data: { kind: "connections", repoPath: node?.data?.repoPath },
      };
      await this.context.setValue(`REACTOR_NODE_${id}`, connections);
      children.push(connections);
    }

    return children;
  }

  async getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]> {
    const attributes = await super.getAttributes(node);

    if (node.type === ReactorNodeType.DATASTORE) {
      attributes.push({
        id: Hash(`${node.id}_project_link`),
        key: "menu-project-link",
        value: { link: "https://github.com/Worldremit/wr-database", icon: "file_open", title: "GitHub" },
      });
      attributes.push({
        id: Hash(`${node.id}_menu-form-edit`),
        key: "menu-form-edit",
        value: { formId: "reactor.TSqlProjectForm@1.0.0", formProps: { id: node.id }, icon: "edit", title: "Edit Project" },
      });
      attributes.push({
        id: Hash(`${node.id}_menu-form-statistics`),
        key: "menu-form-statistics",
        value: { formId: "reactor.TSqlProjectStatisicsForm@1.0.0", formProps: { id: node.id }, icon: "monitoring", title: "Project Stats" },
      });
      attributes.push({
        id: Hash(`${node.id}_menu-index`),
        key: "menu-index",
        value: { formId: "reactor.ProjectIndexForm@1.0.0", formProps: { id: node.id }, icon: "location_searching", title: "Index Project" },
      });
      attributes.push({
        id: Hash(`${node.id}_menu-crawl`),
        key: "menu-crawl",
        value: { formId: "reactor.ProjectCrawlForm@1.0.0", formProps: { id: node.id }, icon: "travel_explore", title: "Crawl Project" },
      });
    }

    return attributes;
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    try {
      const files = fs.readdirSync(project.repoPath);
      return files.some((f) => f.endsWith(".sqlproj") || f.endsWith(".dacpac"));
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return this.supportsProject(project) ? ["tsql"] : [];
  }
}

export default TSqlProjectProcessor;
