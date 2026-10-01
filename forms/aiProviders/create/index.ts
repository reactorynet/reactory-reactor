import Reactory from '@reactorynet/reactory-core';
import { AiProviderCreateSchema } from '../edit/schema';
import uiSchema from '../edit/uiSchema';
import graphql from '../edit/graphql';

/**
 * reactor.AiProviderCreate@1.0.0
 *
 * Create-mode editor. Shares the uiSchema and graphql definition with
 * reactor.AiProviderEdit@1.0.0 but uses the create schema, where the provider id
 * is required and editable.
 *
 * A distinct form id is required because the client caches the resolved form
 * definition per id (see ../edit/schema.ts for the rationale).
 */
const AiProviderCreateForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.AiProviderCreate@1.0.0',
  nameSpace: 'reactor',
  name: 'AiProviderCreate',
  version: '1.0.0',
  title: 'New AI Provider',
  description: 'Create an AI provider',
  icon: 'add_circle',
  registerAsComponent: true,
  schema: AiProviderCreateSchema,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema,
  graphql,
  backButton: false,
  roles: ['USER'],
};

export default AiProviderCreateForm;
