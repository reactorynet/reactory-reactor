import Reactory from '@reactorynet/reactory-core';
import { workflowSteps } from './steps';
import { loadYamlWorkflow } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlToWorkflow';

/**
 * YAML workflows that ship WITH the reactor module.
 *
 * Each entry declares its own namespace and version because `loadYamlWorkflow`
 * derives the catalog destination from the TS arguments, NOT from the YAML body:
 *
 *   <REACTORY_DATA>/workflows/catalog/<nameSpace>/<name>/<version>/<filename>
 *
 * A single module-wide namespace/version would provision a `core.*` workflow into
 * the `reactor/` catalog tree while its body still declared `nameSpace: core`,
 * leaving two divergent copies and a `location` that does not match the
 * definition's identity.
 *
 * SOURCE OF TRUTH
 * ---------------
 * `loadYamlWorkflow(..., sourceDir)` calls `provisionCatalogFile`, which copies
 * the module file over the catalog file on EVERY startup. These module YAML files
 * are therefore canonical: an edit made directly in the data catalog via
 * `saveWorkflowYaml` is overwritten on the next boot. Change the YAML here, then
 * restart.
 */
interface IReactorYamlWorkflow {
  /** Workflow namespace, as declared in the YAML body. */
  nameSpace: string;
  /** Workflow name, as declared in the YAML body. */
  name: string;
  /** File name relative to this directory. */
  filename: string;
  /** Semantic version, as declared in the YAML body. */
  version: string;
}

const REACTOR_YAML_WORKFLOWS: IReactorYamlWorkflow[] = [
  // ── Reactor namespace ──────────────────────────────────────────────────────
  { nameSpace: 'reactor', name: 'AgentGitCommit', filename: 'AgentGitCommit.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'AgentGitWorktree', filename: 'AgentGitWorktree.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'CatalogAgentMemory', filename: 'CatalogAgentMemory.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'CatalogProjectFolder', filename: 'CatalogProjectFolder.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'CatalogProjectGraph', filename: 'CatalogProjectGraph.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'SyncExternalSources', filename: 'SyncExternalSources.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'GraphExplore', filename: 'GraphExplore.yaml', version: '1.0.0' },
  { nameSpace: 'reactor', name: 'ProcessConversationWorkflow', filename: 'ProcessConversationWorkflow.yaml', version: '1.0.0' },

  // ── Durable agent continuation (REACTORY-302016408) ────────────────────────
  // One instance per parked continuation. Started at REGISTRATION from the live
  // session context (see AgentContinuation.yaml), never at fire time — that is
  // what makes the wake turn attributable to the session owner.
  { nameSpace: 'reactor', name: 'AgentContinuation', filename: 'AgentContinuation.yaml', version: '1.0.0' },
  // The 60s clock: publishes the wake event (or the not_observed sentinel at the
  // deadline) under each waiting instance's own tenant. Schedule lives in
  // reactory-data: workflows/schedules/reactor.agentcontinuationsweeper-1.0.0-schedule.yaml.
  { nameSpace: 'reactor', name: 'AgentContinuationSweeper', filename: 'AgentContinuationSweeper.yaml', version: '1.0.0' },

  // ── AI engineering ticket pipeline (core namespace) ────────────────────────
  // Ships with the reactor module because the pipeline is an AI capability, even
  // though it uses the `core` workflow namespace alongside the Support triage /
  // escalation workflows it plugs into.
  { nameSpace: 'core', name: 'ProcessAITicket', filename: 'ProcessAITicket.yaml', version: '1.4.6' },
  { nameSpace: 'core', name: 'DispatchAITickets', filename: 'DispatchAITickets.yaml', version: '1.0.0' },
  { nameSpace: 'core', name: 'RequestAIRouting', filename: 'RequestAIRouting.yaml', version: '1.0.0' },
];

const Workflows: Reactory.Workflow.IWorkflow[] = REACTOR_YAML_WORKFLOWS
  .map(({ nameSpace, name, filename, version }) => loadYamlWorkflow(nameSpace, name, filename, version, __dirname))
  .filter((w): w is Reactory.Workflow.IWorkflow => w !== null);

export { workflowSteps, Workflows };
export default Workflows;
