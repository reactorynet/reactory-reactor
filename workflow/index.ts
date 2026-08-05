import Reactory from '@reactorynet/reactory-core';
import { workflowSteps } from './steps';
import { loadYamlWorkflow } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlToWorkflow';

const NS = 'reactor';
const VERSION = '1.0.0';

const YAML_WORKFLOWS = [
  'AgentGitCommit',
  'AgentGitWorktree',
  'CatalogProjectFolder',
  'GraphExplore',
  'ProcessConversationWorkflow',
];

const Workflows: Reactory.Workflow.IWorkflow[] = YAML_WORKFLOWS
  .map((name) => loadYamlWorkflow(NS, name, `${name}.yaml`, VERSION, __dirname))
  .filter((w): w is Reactory.Workflow.IWorkflow => w !== null);

export { workflowSteps, Workflows };
export default Workflows;
