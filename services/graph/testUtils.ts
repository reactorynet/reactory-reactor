import fs from "fs";
import os from "os";
import path from "path";
import { ReactorNode, ReactorNodeType } from "../../types/model.types";
import { nodeId, pathLogicalKey, projectFqn } from "./GraphIdentity";

/**
 * Minimal in-memory Reactory context for driving processors/analyzers in unit
 * tests without DI or a database. `__store` exposes the node cache for
 * assertions.
 */
export const makeContext = () => {
  const store = new Map<string, any>();
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
    getService: () => null,
    __store: store,
  } as any;
};

export interface TestProject {
  id: string;
  name: string;
  nameSpace: string;
  version: string;
  repoPath: string;
}

/**
 * Writes a temp project from a map of relative-path -> file-content and returns
 * a project descriptor. Intermediate directories are created automatically.
 */
export const writeProject = (
  files: Record<string, string>,
  opts: { name?: string; nameSpace?: string; version?: string } = {}
): { dir: string; project: TestProject } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-graph-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const project: TestProject = {
    id: `${opts.name || "fixture"}-id`,
    name: opts.name || "fixture",
    nameSpace: opts.nameSpace || "test",
    version: opts.version || "1.0.0",
    repoPath: dir,
  };
  return { dir, project };
};

export const cleanup = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

/** Build a FILE node for a project-relative path, as the base processor would. */
export const fileNodeFor = (
  project: TestProject,
  rel: string,
  language: string
): ReactorNode => {
  const fqn = projectFqn(project);
  const id = nodeId(pathLogicalKey(fqn, rel));
  return {
    id,
    index: id,
    name: path.basename(rel),
    key: `${nodeId(fqn)}|${id}`,
    type: ReactorNodeType.FILE,
    parentId: nodeId(fqn),
    providerId: "reactor.TestProcessor@1.0.0",
    nameSpace: project.nameSpace,
    version: project.version,
    source: path.join(project.repoPath, rel),
    children: [],
    data: {
      path: path.join(project.repoPath, rel),
      relativePath: rel,
      repoPath: project.repoPath,
      projectFqn: fqn,
      projectId: project.id,
      kind: "file",
      language,
    },
  } as ReactorNode;
};

/** Deterministic symbol node id for assertions. */
export const symbolId = (
  project: TestProject,
  rel: string,
  symbolPath: string
): number => nodeId(`${projectFqn(project)}::${rel}#${symbolPath}`);

/** Deterministic file node id for assertions. */
export const fileId = (project: TestProject, rel: string): number =>
  nodeId(pathLogicalKey(projectFqn(project), rel));
