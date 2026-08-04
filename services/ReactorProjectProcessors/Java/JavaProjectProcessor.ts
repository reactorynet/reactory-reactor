import fs from "fs";
import path from "path";
import {
  IReactorProject,
  KnownReactorProjectTypes,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { service } from "@reactory/server-core/application/decorators";
import BaseProjectProcessor, { FileAnalysisResult } from "../BaseProjectProcessor";
import { analyseJavaFile } from "../../graph/analyzers/JavaAnalyzer";
import { analyseKotlinFile } from "../../graph/analyzers/KotlinAnalyzer";

@service({
  name: "JavaProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Processor for Java / JVM projects (maven, gradle, ant)",
  id: "reactor.JavaProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
class JavaProjectProcessor extends BaseProjectProcessor {
  nameSpace = "reactor";
  name = "JavaProjectProcessor";
  version = "1.0.0";

  protected iconKey(): string {
    return "java";
  }

  protected async analyseFileFull(fileNode: ReactorNode): Promise<FileAnalysisResult> {
    // JVM/Gradle projects frequently mix Java and Kotlin sources in the same
    // module — this processor handles both rather than requiring a separate
    // Kotlin-only project processor.
    const language = fileNode?.data?.language;
    if (language === "kotlin") return analyseKotlinFile(fileNode, this.context);
    if (language !== "java") return { symbols: [], externals: [], edges: [] };
    return analyseJavaFile(fileNode, this.context);
  }

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    const javaBuildFiles = [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradlew",
      "mvnw",
      "build.xml",
    ];
    try {
      return javaBuildFiles.some((file) => fs.existsSync(path.join(root, file)));
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[] {
    if (!this.supportsProject(project)) return [];
    const root = project.repoPath;
    if (fs.existsSync(path.join(root, "pom.xml")) || fs.existsSync(path.join(root, "mvnw")))
      return ["java"];
    if (
      fs.existsSync(path.join(root, "build.gradle")) ||
      fs.existsSync(path.join(root, "build.gradle.kts")) ||
      fs.existsSync(path.join(root, "gradlew"))
    )
      return ["gradle"];
    if (fs.existsSync(path.join(root, "build.xml"))) return ["ant"];
    return ["java"];
  }
}

export default JavaProjectProcessor;
