import { 
  ServiceRegisterComponentDefinition,
  RunWorkflowComponentDefinition,
} from './macro';
import { ExecuteYamlWorkflowRegistry } from './executeYaml.macro';
import { ListWorkflowsRegistry } from './listWorkflows.macro';
import { GetWorkflowRegistry } from './getWorkflow.macro';
import { GetWorkflowYamlRegistry } from './getWorkflowYaml.macro';
import { SaveWorkflowYamlRegistry } from './saveWorkflowYaml.macro';
import { ValidateWorkflowYamlRegistry } from './validateWorkflowYaml.macro';
import { DeleteWorkflowDefinitionRegistry } from './deleteWorkflowDefinition.macro';
import { ListWorkflowInstancesRegistry } from './listWorkflowInstances.macro';
import { GetWorkflowHistoryRegistry } from './getWorkflowHistory.macro';
import { GetWorkflowStatsRegistry } from './getWorkflowStats.macro';
import { ListWorkflowSchedulesRegistry } from './listWorkflowSchedules.macro';
import { GetWorkflowErrorsRegistry } from './getWorkflowErrors.macro';
import { GetRecentExecutionsRegistry } from './getRecentExecutions.macro';
import { ControlWorkflowInstanceRegistry } from './controlWorkflowInstance.macro';
import { ListWorkflowStepsRegistry } from './listWorkflowSteps.macro';

export default [
  ServiceRegisterComponentDefinition,
  RunWorkflowComponentDefinition,
  ExecuteYamlWorkflowRegistry,
  ListWorkflowsRegistry,
  GetWorkflowRegistry,
  GetWorkflowYamlRegistry,
  SaveWorkflowYamlRegistry,
  ValidateWorkflowYamlRegistry,
  DeleteWorkflowDefinitionRegistry,
  ListWorkflowInstancesRegistry,
  GetWorkflowHistoryRegistry,
  GetWorkflowStatsRegistry,
  ListWorkflowSchedulesRegistry,
  GetWorkflowErrorsRegistry,
  GetRecentExecutionsRegistry,
  ControlWorkflowInstanceRegistry,
  ListWorkflowStepsRegistry,
];