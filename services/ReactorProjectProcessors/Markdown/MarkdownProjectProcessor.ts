import fs from "fs";
import path from "path";
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
  name: "MarkdownProjectProcessor",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for cataloging and graphing Markdown documentation and standard text-based projects",
  id: "reactor.MarkdownProjectProcessor@1.0.0",
  serviceType: "data",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "core.ReactorySearchService@1.0.0", alias: "searchService" },
  ],
})
export class MarkdownProjectProcessor extends BaseProjectProcessor {
  nameSpace: string = "reactor";
  name: string = "MarkdownProjectProcessor";
  version: string = "1.0.0";

  supportsProject(project: Partial<IReactorProject>): boolean {
    if (!project?.repoPath) return false;
    const root = project.repoPath;
    try {
      // Matches if there are .md or .markdown files in the project
      const files = fs.readdirSync(root);
      const hasMarkdown = files.some(file => file.endsWith(".md") || file.endsWith(".markdown") || file === "docs");
      return hasMarkdown;
    } catch {
      return false;
    }
  }

  getProjectTypes(project: Partial<IReactorProject>): any[] {
    return this.supportsProject(project) ? ["documentation", "markdown"] : [];
  }

  protected iconKey(): string | null {
    return "markdown";
  }

  protected async analyseFileFull(fileNode: ReactorNode): Promise<FileAnalysisResult> {
    const filePath = fileNode.data?.path;
    if (!filePath || !fs.existsSync(filePath)) {
      return { symbols: [], externals: [], edges: [] };
    }

    const fileName = path.basename(filePath);
    const symbols: ReactorNode[] = [];
    const edges: ReactorNodeLink[] = [];

    // We only process Markdown files
    if (!fileName.endsWith(".md") && !fileName.endsWith(".markdown")) {
      return { symbols: [], externals: [], edges: [] };
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      // 1. Extract Headings as Symbol Nodes
      lines.forEach((line, index) => {
        const headingMatch = line.match(/^(#+)\s+(.+)$/);
        if (headingMatch) {
          const [_, hashes, title] = headingMatch;
          const level = hashes.length;
          const headingNodeId = Hash(`heading:${level}:${title}:${filePath}`);
          
          const headingNode: ReactorNode = {
            id: headingNodeId,
            key: `${headingNodeId}`,
            name: title.trim(),
            type: ReactorNodeType.CHILD,
            description: `Markdown Heading Level ${level}`,
            data: { title, level, line: index + 1, path: filePath, kind: "heading" },
          };
          symbols.push(headingNode);
        }
      });

      // 2. Extract relative Markdown Links and create REFERENCE edges
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const [_, label, dest] = match;
        // Check if destination is a relative file path (not an absolute URL or anchor)
        if (!dest.startsWith("http://") && !dest.startsWith("https://") && !dest.startsWith("#")) {
          const cleanDest = dest.split("#")[0]; // strip anchors
          if (cleanDest) {
            const absoluteDestPath = path.resolve(path.dirname(filePath), cleanDest);
            if (fs.existsSync(absoluteDestPath)) {
              const targetNodeId = Hash(`file:${absoluteDestPath}`);
              const fileNodeId = Hash(`file:${filePath}`);
              edges.push({
                id: Hash(`link:${fileNodeId}:${targetNodeId}`),
                source: fileNodeId,
                target: targetNodeId,
                types: [ReactorLinkType.REFERENCE],
                title: `references ${label}`,
              });
            }
          }
        }
      }
    } catch (err) {
      this.context.error(`MarkdownProjectProcessor error parsing ${fileName}: ${(err as Error).message}`);
    }

    return { symbols, externals: [], edges };
  }
}

export default MarkdownProjectProcessor;
