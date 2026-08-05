import fs from "fs";
import path from "path";
import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor, { FileAnalysisResult } from "../BaseProjectProcessor";
import { analysePythonFile } from "../../graph/analyzers/PythonAnalyzer";

@service({
  name: "PythonProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for Python projects (requirements.txt, setup.py, pyproject.toml)",
  id: "reactor.PythonProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class PythonProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "PythonProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "python";
  }

  protected async analyseFileFull(fileNode: ReactorNode): Promise<FileAnalysisResult> {
    // Non-Python files fall through to the base, which outlines documentation.
    if (fileNode?.data?.language !== "python")
      return super.analyseFileFull(fileNode);
    return analysePythonFile(fileNode, this.context);
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    try {
      return (
        fs.existsSync(path.join(root, "requirements.txt")) ||
        fs.existsSync(path.join(root, "setup.py")) ||
        fs.existsSync(path.join(root, "pyproject.toml"))
      );
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return this.supportsProject(project) ? ["python"] : [];
  }
}

export default PythonProjectProcessor;
