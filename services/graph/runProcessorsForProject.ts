import { randomUUID } from "crypto";
import Reactory from "@reactorynet/reactory-core";
import {
  IReactorProject,
  IProjectProcessor,
  ProcessOptions,
} from "../../types/service.types";
import { canonicalProjectId } from "./GraphIdentity";

export interface RunProcessorsOptions extends ProcessOptions {
  processorFqns?: string[];
}

export interface RunProcessorsArgs {
  project: Partial<IReactorProject>;
  getProcessor: (fqnOrId: string) => IProjectProcessor | null;
  detectFqns?: () => Promise<string[]>;
  opts?: RunProcessorsOptions;
  onAfterAll?: (projectId: string) => Promise<void>;
  log?: {
    error: (msg: string, ...args: any[]) => void;
    warn: (msg: string, ...args: any[]) => void;
    info: (msg: string, ...args: any[]) => void;
  };
}

export interface RunProcessorsResult {
  project: Partial<IReactorProject>;
  runId: string;
  results: any[];
}

/**
 * Canonical orchestration helper for running graph processors against a project.
 * Shared by SystemGraphManager.catalogProject and ReactorProjectService.processProject.
 *
 * Guarantees:
 *  - Canonical string projectId is stamped and stable throughout the run
 *  - A single shared runId is used across all processors
 *  - GC runs only on the last processor (skipGc: true for all preceding)
 *  - Returned project mutations from each processor are merged sequentially
 *  - Optional onAfterAll (e.g. cross-project dependency linking) runs once at the end
 */
export async function runProcessorsForProject(
  args: RunProcessorsArgs
): Promise<RunProcessorsResult> {
  const { project, getProcessor, detectFqns, opts, onAfterAll, log } = args;

  let nextProject = { ...project };
  const projectId = canonicalProjectId(nextProject);
  if (projectId) {
    nextProject.id = projectId;
  }

  // 1. Resolve processor FQNs / identifiers
  let processorFqns: string[] = [];

  if (nextProject.providerId) {
    processorFqns = [nextProject.providerId];
  } else if (opts?.processorFqns && opts.processorFqns.length > 0) {
    processorFqns = [...opts.processorFqns];
  } else if (nextProject.processors && nextProject.processors.length > 0) {
    for (const p of nextProject.processors) {
      if (p.processor) processorFqns.push(p.processor);
      else if (p.id) processorFqns.push(p.id);
    }
  }

  if (processorFqns.length === 0 && detectFqns) {
    try {
      const detected = await detectFqns();
      if (detected && detected.length > 0) {
        processorFqns = detected;
      }
    } catch (detectErr) {
      log?.warn?.(`runProcessorsForProject: detectFqns failed: ${(detectErr as Error).message}`);
    }
  }

  if (processorFqns.length === 0) {
    processorFqns = ["reactor.FileProjectProcessor@1.0.0"];
  }

  // 2. Generate ONE shared runId for this invocation
  const sharedRunId = opts?.runId || randomUUID();
  const n = processorFqns.length;
  const results: any[] = [];

  // 3. Run processors sequentially
  for (let i = 0; i < n; i++) {
    const fqnOrId = processorFqns[i];
    const isLast = i === n - 1;
    try {
      const proc = getProcessor(fqnOrId);
      if (proc && typeof proc.process === "function") {
        const res = await proc.process(nextProject, {
          runId: sharedRunId,
          skipGc: !isLast, // Only the last processor performs GC
          forceFull: opts?.forceFull,
          linkDocMentions: opts?.linkDocMentions,
        });
        if (res) {
          if (Array.isArray(res)) {
            results.push(...res);
          } else {
            nextProject = { ...nextProject, ...res };
          }
        }
      } else {
        log?.warn?.(
          `runProcessorsForProject: processor "${fqnOrId}" not found or does not implement process()`
        );
      }
    } catch (procErr) {
      log?.error?.(
        `runProcessorsForProject: error processing with "${fqnOrId}": ${(procErr as Error).message}`
      );
    }
  }

  // 4. Run post-processing hook once at end (e.g. cross-project linking)
  if (onAfterAll && projectId) {
    try {
      await onAfterAll(projectId);
    } catch (postErr) {
      log?.warn?.(
        `runProcessorsForProject: onAfterAll failed: ${(postErr as Error).message}`
      );
    }
  }

  return {
    project: nextProject,
    runId: sharedRunId,
    results,
  };
}

export default runProcessorsForProject;
