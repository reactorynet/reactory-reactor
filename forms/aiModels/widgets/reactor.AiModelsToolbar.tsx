import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiModelsToolbar@1.0.0
 *
 * Custom toolbar for the AI Models grid: search, "Add Model" and the create/edit
 * modal (FullScreenModal + ReactoryForm).
 *
 * The modal is also opened on demand via the `reactor.AiModelEditRequested`
 * event raised by reactor.AiModelWorkflow@1.0.0 (grid add button) or the detail
 * panel's Edit button.
 */

interface AiModelsToolbarDependencies {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
  FullScreenModal: any;
  ReactoryForm: Reactory.Forms.IReactoryFormComponent;
  AiModelWorkflow: any;
}

interface AiModelsToolbarProps {
  reactory: Reactory.Client.IReactoryApi;
  loading?: boolean;
  data?: {
    data?: any[];
    paging?: any;
    selected?: any[];
  };
  queryVariables?: {
    filter?: { searchString?: string; [key: string]: any };
    paging?: { page?: number; pageSize?: number };
  };
  searchText?: string;
  onSearchChange?: (text: string) => void;
  onQueryChange?: (queryName: string, variables: any) => void;
  onDataChange?: (data: any[]) => void;
}

const EDIT_REQUESTED_EVENT = 'reactor.AiModelEditRequested';
const EDIT_FORM = 'reactor.AiModelEdit@1.0.0';
const CREATE_FORM = 'reactor.AiModelCreate@1.0.0';

const AiModelsToolbar = (props: AiModelsToolbarProps) => {
  const { reactory, data, queryVariables, searchText = '', onSearchChange, onQueryChange, loading } = props;

  const { React, Material, FullScreenModal, ReactoryForm, AiModelWorkflow } =
    reactory.getComponents<AiModelsToolbarDependencies>([
      'react.React',
      'material-ui.Material',
      'core.FullScreenModal',
      'core.ReactoryForm',
      'reactor.AiModelWorkflow',
    ]);

  const activeSearch = queryVariables?.filter?.searchString ?? searchText ?? '';
  const [searchInput, setSearchInput] = React.useState<string>(activeSearch);
  const [modal, setModal] = React.useState<{ open: boolean; mode: 'create' | 'edit'; model?: any; providerId?: string }>({
    open: false,
    mode: 'create',
    model: null,
  });
  const [editorForm, setEditorForm] = React.useState<any>(null);
  const [saving, setSaving] = React.useState<boolean>(false);

  React.useEffect(() => {
    setSearchInput(activeSearch);
  }, [activeSearch]);

  React.useEffect(() => {
    const handleEditRequest = (request: any) => {
      const mode: 'create' | 'edit' = request?.mode === 'edit' ? 'edit' : 'create';
      setModal({
        open: true,
        mode,
        model: request?.model || null,
        providerId: request?.providerId || request?.model?.providerId,
      });
    };
    reactory.on(EDIT_REQUESTED_EVENT, handleEditRequest);
    return () => {
      reactory.off(EDIT_REQUESTED_EVENT, handleEditRequest);
    };
  }, [reactory]);

  React.useEffect(() => {
    if (!modal.open) return;
    const formFqn = modal.mode === 'edit' ? EDIT_FORM : CREATE_FORM;
    const definition = reactory.form(formFqn, (form: any, error?: Error) => {
      setEditorForm(error ? null : form);
    });
    if (definition) setEditorForm(definition);
  }, [modal.open, modal.mode, reactory]);

  const runQuery = (filter: any, page: number) => {
    if (!onQueryChange) return;
    onQueryChange('models', {
      ...queryVariables,
      filter: { ...(queryVariables?.filter || {}), ...filter },
      paging: { ...(queryVariables?.paging || {}), page },
    });
  };

  const handleSearch = () => {
    if (onSearchChange) onSearchChange(searchInput);
    runQuery({ searchString: searchInput }, 1);
  };

  const handleClearSearch = () => {
    setSearchInput('');
    if (onSearchChange) onSearchChange('');
    runQuery({ searchString: '' }, 1);
  };

  const handleKeyPress = (event: any) => {
    if (event.key === 'Enter') handleSearch();
  };

  const openCreate = () => setModal({ open: true, mode: 'create', model: null });
  const closeModal = () => {
    setModal({ open: false, mode: 'create', model: null });
    setSaving(false);
  };

  const handleSubmit = async (formData: any) => {
    if (!AiModelWorkflow?.saveModel) return;
    setSaving(true);
    try {
      const saved = await AiModelWorkflow.saveModel({
        mode: modal.mode,
        values: formData,
        model: modal.model,
      });
      if (saved) closeModal();
    } finally {
      setSaving(false);
    }
  };

  // All hooks have been called - safe to bail out while dependencies load.
  if (!Material || !FullScreenModal) {
    return <>Loading toolbar...</>;
  }

  const { MaterialCore, MaterialIcons } = Material;
  const { Box, Button, Icon, Toolbar, Tooltip, TextField, InputAdornment, IconButton, Divider, Typography } =
    MaterialCore;
  const { Search: SearchIcon, Clear: ClearIcon } = MaterialIcons || {};

  const selectedCount = (data?.selected || []).length;
  const isEdit = modal.mode === 'edit';

  const modalContent = () => {
    if (!editorForm) return <Typography variant="body2">Loading form...</Typography>;
    // The grid row exposes the model key as `id` (ReactorModelDefinition.id),
    // while the editor names the field `modelKey` - map it so the read-only
    // "Model Key" field is populated in edit mode.
    const initialData = isEdit
      ? { ...modal.model, modelKey: modal.model?.modelKey || modal.model?.id }
      : { providerId: modal.providerId || '', supportsStreaming: true, isEnabled: true, sortOrder: 0 };
    return <ReactoryForm formDef={editorForm} formData={initialData} onSubmit={handleSubmit} />;
  };

  return (
    <>
      <Toolbar
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 2,
          p: 2,
        }}
      >
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            placeholder="Search models by name, key or provider..."
            value={searchInput}
            onChange={(event: any) => setSearchInput(event.target.value)}
            onKeyPress={handleKeyPress}
            sx={{ flex: 1, minWidth: 240 }}
            InputProps={{
              startAdornment: SearchIcon && (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
              endAdornment: searchInput && ClearIcon && (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={handleClearSearch}>
                    <ClearIcon />
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Button variant="outlined" onClick={handleSearch} startIcon={SearchIcon && <SearchIcon />}>
            Search
          </Button>

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Add a new AI model">
            <Button
              variant="contained"
              color="primary"
              startIcon={<Icon>add</Icon>}
              onClick={openCreate}
              disabled={loading === true}
            >
              Add Model
            </Button>
          </Tooltip>
        </Box>

        {selectedCount > 0 && (
          <>
            <Divider />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Icon>check_box</Icon>
              <Typography variant="body2" color="textSecondary">
                {selectedCount} model{selectedCount > 1 ? 's' : ''} selected
              </Typography>
            </Box>
          </>
        )}
      </Toolbar>

      {FullScreenModal && (
        <FullScreenModal
          open={modal.open === true}
          title={isEdit ? `Edit model: ${modal.model?.name || modal.model?.id || ''}` : 'New AI Model'}
          onClose={closeModal}
        >
          {modal.open === true ? modalContent() : null}
        </FullScreenModal>
      )}
    </>
  );
};

const Definition: any = {
  name: 'AiModelsToolbar',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiModelsToolbar,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiModelsToolbar,
    ['AI Models', 'Toolbar'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiModelsToolbar,
  });
}

export default AiModelsToolbar;
