import Reactory from '@reactorynet/reactory-core';
import { AiModelCreateSchema } from '../edit/schema';
import uiSchema from '../edit/uiSchema';
import graphql from '../edit/graphql';

/**
 * reactor.AiModelCreate@1.0.0
 *
 * Create-mode model editor. Shares the uiSchema and graphql definition with
 * reactor.AiModelEdit@1.0.0 but uses the create schema, where providerId and
 * modelKey are required and editable.
 *
 * A distinct form id is required because the client caches the resolved form
 * definition per id (see ../edit/schema.ts).
 */
const AiModelCreateForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.AiModelCreate@1.0.0',
  nameSpace: 'reactor',
  name: 'AiModelCreate',
  version: '1.0.0',
  title: 'New AI Model',
  description: 'Create an AI model under a provider',
  icon: 'add_circle',
  registerAsComponent: true,
  schema: AiModelCreateSchema,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema,
  graphql,
  backButton: false,
  roles: ['USER'],
};

export default AiModelCreateForm;
