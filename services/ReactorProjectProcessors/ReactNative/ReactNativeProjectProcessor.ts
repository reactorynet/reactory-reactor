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
  name: "ReactNativeProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for React Native projects",
  id: "reactor.ReactNativeProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class ReactNativeProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "ReactNativeProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "react-native";
  }

  protected async analyseFileFull(
    fileNode: ReactorNode
  ): Promise<FileAnalysisResult> {
    const language = fileNode?.data?.language;
    // Anything else falls through to the base, which outlines documentation.
    if (language !== "typescript" && language !== "javascript")
      return super.analyseFileFull(fileNode);
    return analyseTypeScriptFile(fileNode, this.context);
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    try {
      const pkgPath = path.join(project.repoPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps["react-native"];
      }
    } catch {
      // ignore
    }
    return false;
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return this.supportsProject(project) ? ["react-native"] : [];
  }
}

export default ReactNativeProjectProcessor;
