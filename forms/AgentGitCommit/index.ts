import schema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const AgentGitCommitForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.AgentGitCommitInputForm@1.0.0',
  name: 'AgentGitCommitInputForm',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema,
  uiSchema,
  graph: graphql,
  description: `AI-driven git commit: gathers repo context, consults the Reactor agent, executes the agent's decision.`,
  uiFramework: 'material',
  uiSupport: ['material'],
  title: 'Agent Git Commit Workflow',
  registerAsComponent: true,
};

export default AgentGitCommitForm;
