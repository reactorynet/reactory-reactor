/**
 * Reactory Reactor Workflow Steps
 *
 * Exports all step implementations provided by the reactory-reactor module
 * and a workflowSteps array matching the IWorkflowStepProvider[] interface
 * for registration with the YAML workflow step registry.
 */

import Reactory from '@reactorynet/reactory-core';

import { GraphQLQueryStep } from './GraphQLQueryStep';
import { GraphQLMutationStep } from './GraphQLMutationStep';
import { MongoQueryStep } from './MongoQueryStep';
import { MongoWriteStep } from './MongoWriteStep';
import { SearchStep } from './SearchStep';
import { EmailStep } from './EmailStep';
import { UserLookupStep } from './UserLookupStep';
import { SetVariableStep } from './SetVariableStep';
import { TodoStep } from './TodoStep';

/**
 * All workflow step providers registered by the reactory-reactor module.
 * Each entry maps a step type identifier to its implementing class.
 */
export const workflowSteps: Reactory.Workflow.IWorkflowStepProvider[] = [
  {
    stepType: 'graphql_query',
    constructor: GraphQLQueryStep,
    options: {
      description: 'Execute a GraphQL query against the Reactory server',
    },
  },
  {
    stepType: 'graphql_mutation',
    constructor: GraphQLMutationStep,
    options: {
      description: 'Execute a GraphQL mutation against the Reactory server',
    },
  },
  {
    stepType: 'mongo_query',
    constructor: MongoQueryStep,
    options: {
      description: 'Execute MongoDB read operations (find, findOne, aggregate, count)',
    },
  },
  {
    stepType: 'mongo_write',
    constructor: MongoWriteStep,
    options: {
      description: 'Execute MongoDB write operations (insert, update, delete)',
    },
  },
  {
    stepType: 'search',
    constructor: SearchStep,
    options: {
      description: 'Execute MeiliSearch operations (search, index, createIndex, deleteIndex)',
    },
  },
  {
    stepType: 'email',
    constructor: EmailStep,
    options: {
      description: 'Send emails via the Reactory email service',
    },
  },
  {
    stepType: 'user_lookup',
    constructor: UserLookupStep,
    options: {
      description: 'Look up a Reactory user by email, id, or username',
    },
  },
  {
    stepType: 'set_variable',
    constructor: SetVariableStep,
    options: {
      description: 'Set, get, or delete workflow variables',
    },
  },
  {
    stepType: 'todo',
    constructor: TodoStep,
    options: {
      description: 'Create and manage todo items within a workflow context',
    },
  },
];

export {
  GraphQLQueryStep,
  GraphQLMutationStep,
  MongoQueryStep,
  MongoWriteStep,
  SearchStep,
  EmailStep,
  UserLookupStep,
  SetVariableStep,
  TodoStep,
};

export default workflowSteps;
