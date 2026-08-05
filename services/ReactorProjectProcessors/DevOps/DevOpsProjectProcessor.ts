import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { service } from "application/decorators";
import BaseProjectProcessor, { FileAnalysisResult } from "../BaseProjectProcessor";
import {
  IReactorProject,
  IReactorProjectFileSpec,
  IProjectProcessor,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  ReactorNode,
  ReactorNodeType,
  ReactorNodeLink,
  ReactorLinkType,
} from "@reactory/server-modules/reactory-reactor/types/model.types";
import Hash from "@reactory/server-core/utils/hash";

@service({
  name: "DevOpsProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for cataloging and graphing DevOps, Helm charts, and Terraform projects",
  id: "reactor.DevOpsProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
export class DevOpsProjectProcessor extends BaseProjectProcessor {
  nameSpace: string = "reactor";
  name: string = "DevOpsProjectProcessor";
  version: string = "1.0.0";

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    try {
      // Matches if there is a Chart.yaml, atlantis.yaml, or .tf files
      const hasChart = fs.existsSync(path.join(root, "Chart.yaml")) || fs.existsSync(path.join(root, "charts"));
      const hasAtlantis = fs.existsSync(path.join(root, "atlantis.yaml"));
      const hasTerraform = fs.readdirSync(root).some(file => file.endsWith(".tf") || file === "infrastructure");
      return hasChart || hasAtlantis || hasTerraform;
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): any[] {
    return this.supportsProject(project) ? ["devops", "kubernetes", "helm", "terraform"] : [];
  }

  protected iconKey(): string | null {
    return "devops";
  }

  protected async analyseFileFull(fileNode: ReactorNode): Promise<FileAnalysisResult> {
    const filePath = fileNode.data?.path;
    if (!filePath || !fs.existsSync(filePath)) {
      return { symbols: [], externals: [], edges: [] };
    }

    // Documents (runbooks, ADRs, chart READMEs) are outlined by the base.
    if (this.isDocument(filePath, fileNode.data?.language)) {
      return super.analyseFileFull(fileNode);
    }

    const fileName = path.basename(filePath);
    const symbols: ReactorNode[] = [];
    const edges: ReactorNodeLink[] = [];

    try {
      // 1. Parse Helm Chart.yaml
      if (fileName === "Chart.yaml") {
        const content = fs.readFileSync(filePath, "utf8");
        const chart = yaml.load(content) as any;

        const chartNodeId = Hash(`chart:${filePath}`);
        const chartNode: ReactorNode = {
          id: chartNodeId,
          key: `${chartNodeId}`,
          name: chart.name,
          nameSpace: fileNode?.nameSpace || "reactor",
          version: chart.version || "1.0.0",
          type: ReactorNodeType.MODULE,
          description: `Helm Chart v${chart.version}: ${chart.description || ""}`,
          data: { ...chart, path: filePath, kind: "chart" },
        };
        symbols.push(chartNode);

        // Link dependencies listed in Chart.yaml
        if (chart.dependencies) {
          chart.dependencies.forEach((dep: any) => {
            const depId = Hash(`chart-dep:${dep.name}`);
            edges.push({
              id: Hash(`link:${chartNodeId}:${depId}`),
              source: chartNodeId,
              target: depId,
              types: [ReactorLinkType.DEPENDENCY],
              title: `requires chart ${dep.name}`,
            });
          });
        }
      }

      // 2. Parse Atlantis atlantis.yaml
      if (fileName === "atlantis.yaml") {
        const content = fs.readFileSync(filePath, "utf8");
        const atlantis = yaml.load(content) as any;

        const atlantisNodeId = Hash(`atlantis:${filePath}`);
        const atlantisNode: ReactorNode = {
          id: atlantisNodeId,
          key: `${atlantisNodeId}`,
          name: "Atlantis Workflows",
          type: ReactorNodeType.SERVICE,
          description: "Pull-Request-driven Terraform automation configuration",
          data: { ...atlantis, path: filePath, kind: "atlantis" },
        };
        symbols.push(atlantisNode);
      }

      // 3. Parse Terraform .tf files for resource declarations
      if (fileName.endsWith(".tf")) {
        const content = fs.readFileSync(filePath, "utf8");
        // Simple regex to parse resource "aws_xxx" "name"
        const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
        let match;
        while ((match = resourceRegex.exec(content)) !== null) {
          const [_, resourceType, resourceName] = match;
          const resourceNodeId = Hash(`tf-resource:${resourceType}:${resourceName}:${filePath}`);
          const resourceNode: ReactorNode = {
            id: resourceNodeId,
            key: `${resourceNodeId}`,
            name: `${resourceType}.${resourceName}`,
            type: ReactorNodeType.CHILD,
            description: `Terraform Resource: ${resourceType}`,
            data: { type: resourceType, name: resourceName, path: filePath, kind: "tf-resource" },
          };
          symbols.push(resourceNode);
        }
      }
    } catch (err) {
      this.context.error(`DevOpsProjectProcessor error parsing ${fileName}: ${(err as Error).message}`);
    }

    return { symbols, externals: [], edges };
  }
}

export default DevOpsProjectProcessor;
