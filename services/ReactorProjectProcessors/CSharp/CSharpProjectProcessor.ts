import fs from "fs";
import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor, { FileAnalysisResult } from "../BaseProjectProcessor";
import { analyseCSharpFile } from "../../graph/analyzers/CSharpAnalyzer";

@service({
  name: "CSharpProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for C# / .NET projects (.csproj, .sln)",
  id: "reactor.CSharpProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class CSharpProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "CSharpProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "csharp";
  }

  protected async analyseFileFull(fileNode: ReactorNode): Promise<FileAnalysisResult> {
    // Non-C# files fall through to the base, which outlines documentation.
    if (fileNode?.data?.language !== "csharp")
      return super.analyseFileFull(fileNode);
    return analyseCSharpFile(fileNode, this.context);
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const csharpFiles = [".csproj", ".sln", "project.json"];
    try {
      const files = fs.readdirSync(project.repoPath);
      return files.some((file) => csharpFiles.some((ext) => file.endsWith(ext)));
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return this.supportsProject(project) ? ["csharp"] : [];
  }
}

export default CSharpProjectProcessor;
