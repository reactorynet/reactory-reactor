import Reactory from '@reactorynet/reactory-core';
import { AiProviderEditSchema } from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

/**
 * reactor.AiProviderEdit@1.0.0
 *
 * Modal editor for an existing AI provider. Loaded at runtime by
 * reactor.AiProvidersToolbar / reactor.AiProviderDetailPanel:
 *
 *   reactory.form('reactor.AiProviderEdit@1.0.0')
 *
 * and rendered inside a FullScreenModal with `onSubmit` handled by
 * reactor.AiProviderWorkflow@1.0.0 (saveProvider, mode: 'edit').
 */
const AiProviderEditForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.AiProviderEdit@1.0.0',
  nameSpace: 'reactor',
  name: 'AiProviderEdit',
  version: '1.0.0',
  title: 'Edit AI Provider',
  description: 'Update an existing AI provider',
  icon: 'settings',
  registerAsComponent: true,
  schema: AiProviderEditSchema,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema,
  graphql,
  backButton: false,
  roles: ['USER'],
};

export default AiProviderEditForm;
