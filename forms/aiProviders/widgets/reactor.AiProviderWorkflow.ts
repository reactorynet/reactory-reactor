/**
 * reactor.AiProviderWorkflow@1.0.0
 *
 * Client-side workflow module for the AI Providers admin grid.
 *
 * Registered as a `workflow` component (not a React component) so that
 * declarative handlers can reach it by FQN, e.g.
 *   `addButtonProps.onClick: 'reactor.AiProviderWorkflow@1.0.0/addNew'`
 *   `deleteButtonProps.onClick: 'reactor.AiProviderWorkflow@1.0.0/delete'`
 * and grid `actions[].event.component: 'reactor.AiProviderWorkflow@1.0.0'`.
 *
 * The grid previously referenced a component named `reactor.AiProviderWorkflow`
 * that did not exist, so the add/delete buttons were inert. This module is that
 * component.
 *
 * Change notification contract
 * ----------------------------
 *   event   : 'reactor.AiProviderChanged'
 *   payload : { action, providerId?, ids?, provider?, changes? }
 *
 * Subscribers (`MaterialTableWidget.ui:options.refreshEvents`) re-run their query
 * whenever the event fires, so a change made anywhere - toolbar, detail panel or
 * row action - refreshes the grid without a page reload.
 */

interface IAiProviderWorkflowProps {
  reactory: Reactory.Client.IReactoryApi;
}

/** Canonical change event. Any component may subscribe: `reactory.on(EVENT, fn)`. */
export const AI_PROVIDER_CHANGED_EVENT = 'reactor.AiProviderChanged';

/** Raised to ask the toolbar to open the create/edit modal. */
export const AI_PROVIDER_EDIT_REQUESTED_EVENT = 'reactor.AiProviderEditRequested';

/** FQN of the modal editor form loaded by the toolbar / detail panel. */
export const AI_PROVIDER_EDIT_FORM = 'reactor.AiProviderEdit@1.0.0';

/** FQN of the create-mode modal form. Distinct id because the client caches the
 * resolved definition per form id (see forms/aiProviders/edit/schema.ts). */
export const AI_PROVIDER_CREATE_FORM = 'reactor.AiProviderCreate@1.0.0';

/** Resolves the editor form FQN for the given mode. */
export const aiProviderEditorFormFor = (mode: 'create' | 'edit'): string =>
  mode === 'edit' ? AI_PROVIDER_EDIT_FORM : AI_PROVIDER_CREATE_FORM;

export interface IAiProviderChangePayload {
  action: string;
  providerId?: string;
  ids?: string[];
  provider?: any;
  changes?: any;
}

export interface IAiProviderEditRequest {
  mode: 'create' | 'edit';
  provider?: any;
}

export interface IAiProviderWorkflowModule {
  /** Fixes the prior dead reference - opens the create modal. */
  addNew(): void;
  /** Opens the edit modal for a provider (from a row action or detail panel). */
  editProvider(args: { provider?: any; rowData?: any }): void;
  /** Create or update. `values` is the submitted formData from the edit form. */
  saveProvider(args: { mode: 'create' | 'edit'; values: any; provider?: any }): Promise<any | null>;
  /** Bulk (toolbar) and single (row action) delete. */
  delete(args: any): Promise<void>;
  /** Alias used by row actions that call `deleteProvider`. */
  deleteProvider(args: any): Promise<void>;
  /** Test connectivity to a provider endpoint. */
  testConnection(args: { provider?: any; rowData?: any; testModelId?: string }): Promise<any | null>;
  /** Re-sync baseline providers from providers.yaml into the database. */
  syncFromYaml(args?: { overwrite?: boolean }): Promise<any | null>;
  notifyProviderChange(action: string, payload?: Omit<IAiProviderChangePayload, 'action'>): void;
}

const AiProviderWorkflow = (props: IAiProviderWorkflowProps): IAiProviderWorkflowModule => {
  const { reactory } = props;

  const emitProviderChange = (
    action: string,
    payload: Omit<IAiProviderChangePayload, 'action'> = {}
  ): void => {
    const detail: IAiProviderChangePayload = {
      action,
      providerId: payload.providerId || payload.provider?.id,
      ids: payload.ids,
      provider: payload.provider,
      changes: payload.changes,
    };
    try {
      reactory.emit(AI_PROVIDER_CHANGED_EVENT, detail);
    } catch (emitError) {
      reactory.log('AiProviderWorkflow: failed to emit change event', { emitError }, 'warn');
    }
  };

  const requestEdit = (request: IAiProviderEditRequest): void => {
    try {
      reactory.emit(AI_PROVIDER_EDIT_REQUESTED_EVENT, request);
    } catch (emitError) {
      reactory.log('AiProviderWorkflow: failed to emit edit request', { emitError }, 'warn');
    }
  };

  /**
   * Normalises the various argument shapes the grid produces.
   * - toolbar delete button passes `{ rows, rowsState }`
   * - free-action passes `{ selected }`
   * - row action passes `{ rowData }` or `{ rows: [row] }`
   */
  const resolveProviders = (args: any): any[] => {
    if (!args) return [];
    if (Array.isArray(args.selected)) return args.selected;
    if (args.provider) return [args.provider];
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
   * Fields accepted by ReactorCreateAiProviderInput / ReactorUpdateAiProviderInput.
   * The grid row carries extra read-only fields (models, status, ...) that are not
   * part of the input types; GraphQL rejects unknown input fields, so the submitted
   * formData is narrowed to this allow-list.
   */
  const pickProviderInput = (values: any, isEdit: boolean): any => {
    const source = values || {};
    const input: any = {};

    [
      'id',
      'name',
      'description',
      'providerType',
      'endpointUrl',
      'apiVersion',
      'authComponentFqn',
      'capabilities',
      'roles',
      'rateLimits',
      'isEnabled',
    ].forEach((key) => {
      const value = source[key];
      if (value === undefined || value === null || value === '') return;
      input[key] = value;
    });

    // The edit form labels the field `defaultModel` (matching the grid) while the
    // API input uses `defaultModelId`.
    const defaultModel =
      source.defaultModelId !== undefined && source.defaultModelId !== ''
        ? source.defaultModelId
        : source.defaultModel;
    if (defaultModel !== undefined && defaultModel !== '') {
      input.defaultModelId = defaultModel;
    }

    if (typeof input.isEnabled !== 'boolean') {
      input.isEnabled = source.isEnabled !== false;
    }

    // Provider id is immutable once created.
    if (isEdit) delete input.id;
    return input;
  };

  const saveProvider = async (args: { mode: 'create' | 'edit'; values: any; provider?: any }) => {
    const { mode, values, provider } = args;
    const isEdit = mode === 'edit';
    const input = pickProviderInput(values, isEdit);

    try {
      let result: any;
      if (isEdit) {
        const id = `${provider?.id || values?.id}`;
        if (!id) {
          reactory.createNotification('Cannot update provider: no provider id', { type: 'error' });
          return null;
        }
        result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorUpdateAiProvider($id: String!, $input: ReactorUpdateAiProviderInput!) {
            ReactorUpdateAiProvider(id: $id, input: $input) {
              id
              name
              description
              providerType
              endpointUrl
              apiVersion
              defaultModel
              authComponentFqn
              isEnabled
            }
          }`,
          { id, input }
        );
        const saved = result?.data?.ReactorUpdateAiProvider;
        if (saved) {
          reactory.createNotification(`Provider ${saved.name} updated`, { type: 'success' });
          emitProviderChange('updated', { provider: saved, providerId: saved.id, changes: input });
          return saved;
        }
      } else {
        if (!input.id) {
          reactory.createNotification('Cannot create provider: an id is required', { type: 'error' });
          return null;
        }
        result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorCreateAiProvider($input: ReactorCreateAiProviderInput!) {
            ReactorCreateAiProvider(input: $input) {
              id
              name
              description
              providerType
              endpointUrl
              apiVersion
              defaultModel
              authComponentFqn
              isEnabled
            }
          }`,
          { input }
        );
        const saved = result?.data?.ReactorCreateAiProvider;
        if (saved) {
          reactory.createNotification(`Provider ${saved.name} created`, { type: 'success' });
          emitProviderChange('created', { provider: saved, providerId: saved.id, changes: input });
          return saved;
        }
      }

      const message = result?.errors?.[0]?.message || 'Provider save failed';
      reactory.createNotification(message, { type: 'error' });
      return null;
    } catch (error) {
      reactory.createNotification(
        isEdit ? 'Error updating provider' : 'Error creating provider',
        { type: 'error' }
      );
      reactory.log('AiProviderWorkflow: saveProvider failed', { error }, 'error');
      return null;
    }
  };

  const removeProviders = async (args: any): Promise<void> => {
    const providers = resolveProviders(args);
    const ids = providers.map((p) => `${p?.id}`).filter((id) => !!id && id !== 'undefined');

    if (ids.length === 0) {
      reactory.createNotification('No providers selected for deletion', { type: 'warning' });
      return;
    }

    const deleted: string[] = [];
    for (const id of ids) {
      try {
        const result = await reactory.graphqlMutation<any, any>(
          `mutation ReactorDeleteAiProvider($id: String!) {
            ReactorDeleteAiProvider(id: $id)
          }`,
          { id }
        );
        if (result?.data?.ReactorDeleteAiProvider === true) {
          deleted.push(id);
        } else if (result?.errors?.length) {
          reactory.createNotification(`Failed to delete ${id}: ${result.errors[0].message}`, {
            type: 'error',
          });
        }
      } catch (error) {
        reactory.createNotification(`Error deleting provider ${id}`, { type: 'error' });
        reactory.log('AiProviderWorkflow: delete failed', { id, error }, 'error');
      }
    }

    if (deleted.length > 0) {
      reactory.createNotification(
        `${deleted.length} provider${deleted.length > 1 ? 's' : ''} deleted`,
        { type: 'success' }
      );
      emitProviderChange('deleted', { ids: deleted });
    }
  };

  const testConnection = async (args: { provider?: any; rowData?: any; testModelId?: string }) => {
    const provider = args.provider || args.rowData;
    const id = `${provider?.id}`;
    if (!id || id === 'undefined') {
      reactory.createNotification('Cannot test provider: no provider id', { type: 'error' });
      return null;
    }

    try {
      const testModelId = args.testModelId || provider?.defaultModel || undefined;
      const result = await reactory.graphqlMutation<any, any>(
        `mutation ReactorTestAiProvider($id: String!, $testModelId: String) {
          ReactorTestAiProvider(id: $id, testModelId: $testModelId) {
            success
            latencyMs
            message
          }
        }`,
        { id, testModelId }
      );
      const outcome = result?.data?.ReactorTestAiProvider;
      if (outcome) {
        reactory.createNotification(
          outcome.success
            ? `Provider ${id} reachable (${Math.round(outcome.latencyMs)}ms)`
            : `Provider ${id} test failed: ${outcome.message}`,
          { type: outcome.success ? 'success' : 'error' }
        );
        emitProviderChange('tested', { providerId: id, changes: outcome });
        return outcome;
      }
      reactory.createNotification('Provider test failed', { type: 'error' });
      return null;
    } catch (error) {
      reactory.createNotification('Error testing provider connection', { type: 'error' });
      reactory.log('AiProviderWorkflow: testConnection failed', { error }, 'error');
      return null;
    }
  };

  const syncFromYaml = async (args?: { overwrite?: boolean }) => {
    try {
      const result = await reactory.graphqlMutation<any, any>(
        `mutation ReactorSyncAiProvidersFromYaml($overwrite: Boolean) {
          ReactorSyncAiProvidersFromYaml(overwrite: $overwrite)
        }`,
        { overwrite: args?.overwrite !== false }
      );
      const summary = result?.data?.ReactorSyncAiProvidersFromYaml;
      if (summary) {
        reactory.createNotification('AI providers synchronised from YAML', { type: 'success' });
        emitProviderChange('synced', { changes: summary });
      } else {
        reactory.createNotification('Provider sync returned no result', { type: 'warning' });
      }
      return summary;
    } catch (error) {
      reactory.createNotification('Error synchronising providers from YAML', { type: 'error' });
      reactory.log('AiProviderWorkflow: syncFromYaml failed', { error }, 'error');
      return null;
    }
  };

  return {
    notifyProviderChange: emitProviderChange,
    addNew: () => requestEdit({ mode: 'create' }),
    editProvider: (args) => requestEdit({ mode: 'edit', provider: args?.provider || args?.rowData }),
    saveProvider,
    delete: removeProviders,
    deleteProvider: removeProviders,
    testConnection,
    syncFromYaml,
  };
};

const Definition: any = {
  name: 'AiProviderWorkflow',
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
    AiProviderWorkflow({ reactory }),
    ['AI Provider'],
    Definition.roles,
    false,
    [],
    'workflow'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProviderWorkflow,
  });
}

export default AiProviderWorkflow;
