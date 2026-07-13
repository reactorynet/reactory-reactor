import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor from "../BaseProjectProcessor";

/**
 * Generic fallback processor for any folder-based project that no
 * language-specific processor claims. Provides file/folder browsing only.
 */
@service({
  nameSpace: "reactor",
  name: "FileProjectProcessor",
  version: "1.0.0",
  description: "Generic file/folder project processor (fallback)",
  id: "reactor.FileProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class FileProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "FileProjectProcessor";
  version = "1.0.0";

  supportsProject(project: Partial<IReactorProject>): boolean {
    return !!project?.repoPath;
  }

  getProjectTypes(_project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    return [];
  }
}

export default FileProjectProcessor;
