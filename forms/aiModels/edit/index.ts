import Reactory from '@reactorynet/reactory-core';
import { AiModelEditSchema } from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

/**
 * reactor.AiModelEdit@1.0.0
 *
 * Modal editor for an existing AI model, loaded at runtime by
 * reactor.AiModelsToolbar / reactor.AiModelDetailPanel:
 *
 *   reactory.form('reactor.AiModelEdit@1.0.0')
 *
 * and rendered inside a FullScreenModal with `onSubmit` handled by
 * reactor.AiModelWorkflow@1.0.0 (saveModel, mode: 'edit').
 */
const AiModelEditForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.AiModelEdit@1.0.0',
  nameSpace: 'reactor',
  name: 'AiModelEdit',
  version: '1.0.0',
  title: 'Edit AI Model',
  description: 'Update an existing AI model',
  icon: 'memory',
  registerAsComponent: true,
  schema: AiModelEditSchema,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema,
  graphql,
  backButton: false,
  roles: ['USER'],
};

export default AiModelEditForm;
