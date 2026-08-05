import fs from "fs";
import path from "path";
import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor, {
  FileAnalysisResult,
} from "../BaseProjectProcessor";
import { analyseTypeScriptFile } from "../../graph/analyzers/TypeScriptAnalyzer";

@service({
  name: "NodeJSProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for NodeJS / TypeScript projects (package.json based)",
  id: "reactor.NodeJSProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class NodeJSProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "NodeJSProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "nodejs";
  }

  /**
   * TypeScript / JavaScript files are analysed with the TypeScript compiler API
   * into symbol nodes (classes, functions, interfaces, exports), external
   * dependency nodes, and import/dependency edges. Anything else falls through
   * to the base, which outlines the project's documentation.
   */
  protected async analyseFileFull(
    fileNode: ReactorNode
  ): Promise<FileAnalysisResult> {
    const language = fileNode?.data?.language;
    if (language !== "typescript" && language !== "javascript")
      return super.analyseFileFull(fileNode);
    return analyseTypeScriptFile(fileNode, this.context);
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    try {
      return fs.existsSync(path.join(project.repoPath, "package.json"));
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    if (!this.supportsProject(project)) return [];
    const types: KnownReactorProjectTypes[] = ["nodejs"];
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(project.repoPath, "package.json"), "utf-8")
      );
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.typescript) types.push("typescript");
      if (deps.react) types.push("react-web");
      if (deps["react-native"]) types.push("react-native");
    } catch {
      // best effort - package.json may be malformed
    }
    return types;
  }
}

export default NodeJSProjectProcessor;
