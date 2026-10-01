/**
 * reactor.AiModelWorkflow@1.0.0
 *
 * Client-side workflow module for the AI Models admin grid.
 *
 * Registered as a `workflow` component so declarative handlers can reach it:
 *   `addButtonProps.onClick: 'reactor.AiModelWorkflow@1.0.0/addNew'`
 *   `deleteButtonProps.onClick: 'reactor.AiModelWorkflow@1.0.0/delete'`
 * The grid previously referenced these methods on a component that did not
 * exist, so both buttons were inert.
 *
 * Identifier note: the GraphQL `ReactorModelDefinition.id` is the model *key*
 * (`modelKey`), not the row uuid. Updates/deletes therefore pass the key as `id`
 * together with the owning `providerId`, which the service uses to disambiguate
 * models that share a key across providers.
 *
 * Change notification contract
 * ----------------------------
 *   event   : 'reactor.AiModelChanged'
 *   payload : { action, modelId?, providerId?, ids?, model?, changes? }
 */

interface IAiModelWorkflowProps {
  reactory: Reactory.Client.IReactoryApi;
}

export const AI_MODEL_CHANGED_EVENT = 'reactor.AiModelChanged';
export const AI_MODEL_EDIT_REQUESTED_EVENT = 'reactor.AiModelEditRequested';

export const AI_MODEL_EDIT_FORM = 'reactor.AiModelEdit@1.0.0';
export const AI_MODEL_CREATE_FORM = 'reactor.AiModelCreate@1.0.0';

export const aiModelEditorFormFor = (mode: 'create' | 'edit'): string =>
  mode === 'edit' ? AI_MODEL_EDIT_FORM : AI_MODEL_CREATE_FORM;

export interface IAiModelWorkflowModule {
  addNew(args?: { providerId?: string }): void;
  editModel(args: { model?: any; rowData?: any }): void;
  saveModel(args: { mode: 'create' | 'edit'; values: any; model?: any }): Promise<any | null>;
  deleteModel(args: any): Promise<void>;
  /** Alias for the grid delete button handler. */
  delete(args: any): Promise<void>;
  notifyModelChange(action: string, payload?: Record<string, any>): void;
}

const MODEL_FIELDS = `
  id
  providerId
  name
  version
  contextLength
  maxOutputTokens
  supportsStreaming
  supportedTools
  supportedMediaTypes
  capabilities
  inputCostPerTokenUsdCents
  outputCostPerTokenUsdCents
  costPerToken
  rpm
  itpm
  otpm
  maxParallelRequests
  isEnabled
  sortOrder
`;

const AiModelWorkflow = (props: IAiModelWorkflowProps): IAiModelWorkflowModule => {
  const { reactory } = props;

  const emitModelChange = (action: string, payload: Record<string, any> = {}): void => {
    const detail = {
      action,
      modelId: payload.modelId || payload.model?.id,
      providerId: payload.providerId || payload.model?.providerId,
      ids: payload.ids,
      model: payload.model,
      changes: payload.changes,
    };
    try {
      reactory.emit(AI_MODEL_CHANGED_EVENT, detail);
    } catch (emitError) {
      reactory.log('AiModelWorkflow: failed to emit change event', { emitError }, 'warn');
    }
  };

  const requestEdit = (request: { mode: 'create' | 'edit'; model?: any; providerId?: string }): void => {
    try {
      reactory.emit(AI_MODEL_EDIT_REQUESTED_EVENT, request);
    } catch (emitError) {
      reactory.log('AiModelWorkflow: failed to emit edit request', { emitError }, 'warn');
    }
  };

  const resolveModels = (args: any): any[] => {
    if (!args) return [];
    if (Array.isArray(args.selected)) return args.selected;
    if (args.model) return [args.model];
    if (args.rowData) return [args.rowData];
    if (Array.isArray(args.rows)) {
      const { rowsState } = args;
      if (rowsState && typeof rowsState === 'object') {
        const selected = args.rows.filter((_row: any, index: number) => {
          const state = rowsState[index];
          return state && state.selected === true;
        });
        if (selected.length > 0) return selected;
      }
      return args.rows;
    }
    return [];
  };

  /**
   * Narrows the submitted formData to ReactorCreateAiModelInput /
   * ReactorUpdateAiModelInput. The grid row carries read-only extras (all the
   * MODEL_FIELDS plus providerId) that GraphQL would reject as unknown inputs.
   */
  const pickModelInput = (values: any, isEdit: boolean): any => {
    const source = values || {};
    const input: any = {};

    const fields = [
      'name',
      'version',
      'contextLength',
      'maxOutputTokens',
      'capabilities',
      'supportsStreaming',
      'supportedTools',
      'supportedMediaTypes',
      'inputCostPerTokenUsdCents',
      'outputCostPerTokenUsdCents',
      'costPerToken',
      'rpm',
      'itpm',
      'otpm',
      'maxParallelRequests',
      'sampling',
      'thinking',
      'isEnabled',
      'sortOrder',
    ];

    // modelKey and providerId are only settable at creation.
    if (!isEdit) {
      fields.push('providerId', 'modelKey');
    }

    fields.forEach((key) => {
      const value = source[key];
      if (value === undefined || value === null || value === '') return;
      input[key] = value;
    });

    if (typeof input.supportsStreaming !== 'boolean') {
      input.supportsStreaming = source.supportsStreaming !== false;
    }
    if (typeof input.isEnabled !== 'boolean') {
      input.isEnabled = source.isEnabled !== false;
    }

    return input;
  };

  const saveModel = async (args: { mode: 'create' | 'edit'; values: any; model?: any }) => {
    const { mode, values, model } = args;
    const isEdit = mode === 'edit';
    const input = pickModelInput(values, isEdit);

    try {
      let result: any;
      if (isEdit) {
        const modelKey = `${model?.id || values?.id || values?.modelKey}`;
        const providerId = `${model?.providerId || values?.providerId}`;
        if (!modelKey || modelKey === 'undefined') {
          reactory.createNotification('Cannot update model: no model key', { type: 'error' });
          return null;
        }
        result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorUpdateAiModel($id: String!, $input: ReactorUpdateAiModelInput!, $providerId: String) {
            ReactorUpdateAiModel(id: $id, input: $input, providerId: $providerId) {
              ${MODEL_FIELDS}
            }
          }`,
          { id: modelKey, input, providerId: providerId === 'undefined' ? undefined : providerId }
        );
        const saved = result?.data?.ReactorUpdateAiModel;
        if (saved) {
          reactory.createNotification(`Model ${saved.name} updated`, { type: 'success' });
          emitModelChange('updated', { model: saved, modelId: saved.id, changes: input });
          return saved;
        }
      } else {
        if (!input.providerId || !input.modelKey || !input.name) {
          reactory.createNotification(
            'Provider, model key and name are required',
            { type: 'error' }
          );
          return null;
        }
        result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorCreateAiModel($input: ReactorCreateAiModelInput!) {
            ReactorCreateAiModel(input: $input) {
              ${MODEL_FIELDS}
            }
          }`,
          { input }
        );
        const saved = result?.data?.ReactorCreateAiModel;
        if (saved) {
          reactory.createNotification(`Model ${saved.name} created`, { type: 'success' });
          emitModelChange('created', { model: saved, modelId: saved.id, changes: input });
          return saved;
        }
      }

      reactory.createNotification(
        result?.errors?.[0]?.message || 'Model save failed',
        { type: 'error' }
      );
      return null;
    } catch (error) {
      reactory.createNotification(
        isEdit ? 'Error updating model' : 'Error creating model',
        { type: 'error' }
      );
      reactory.log('AiModelWorkflow: saveModel failed', { error }, 'error');
      return null;
    }
  };

  const removeModels = async (args: any): Promise<void> => {
    const models = resolveModels(args);
    const targets = models
      .map((model) => ({ id: `${model?.id}`, providerId: `${model?.providerId}` }))
      .filter((target) => !!target.id && target.id !== 'undefined');

    if (targets.length === 0) {
      reactory.createNotification('No models selected for deletion', { type: 'warning' });
      return;
    }

    const deleted: string[] = [];
    for (const target of targets) {
      try {
        const result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorDeleteAiModel($id: String!, $providerId: String) {
            ReactorDeleteAiModel(id: $id, providerId: $providerId)
          }`,
          {
            id: target.id,
            providerId: target.providerId === 'undefined' ? undefined : target.providerId,
          }
        );
        if (result?.data?.ReactorDeleteAiModel === true) {
          deleted.push(target.id);
        } else if (result?.errors?.length) {
          reactory.createNotification(`Failed to delete ${target.id}: ${result.errors[0].message}`, {
            type: 'error',
          });
        }
      } catch (error) {
        reactory.createNotification(`Error deleting model ${target.id}`, { type: 'error' });
        reactory.log('AiModelWorkflow: deleteModel failed', { target, error }, 'error');
      }
    }

    if (deleted.length > 0) {
      reactory.createNotification(
        `${deleted.length} model${deleted.length > 1 ? 's' : ''} deleted`,
        { type: 'success' }
      );
      emitModelChange('deleted', { ids: deleted });
    }
  };

  return {
    notifyModelChange: emitModelChange,
    addNew: (args) => requestEdit({ mode: 'create', providerId: args?.providerId }),
    editModel: (args) => requestEdit({ mode: 'edit', model: args?.model || args?.rowData }),
    saveModel,
    deleteModel: removeModels,
    delete: removeModels,
  };
};

const Definition: any = {
  name: 'AiModelWorkflow',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: null,
  roles: ['USER'],
  componentType: 'workflow',
};

//@ts-ignore
if (window && window.reactory) {
  //@ts-ignore
  const reactory: Reactory.Client.IReactoryApi = window.reactory.api as Reactory.Client.IReactoryApi;
  reactory.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiModelWorkflow({ reactory }),
    ['AI Model'],
    Definition.roles,
    false,
    [],
    'workflow'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiModelWorkflow,
  });
}

export default AiModelWorkflow;
