import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiProvidersToolbar@1.0.0
 *
 * Custom toolbar for the AI Providers grid. Provides:
 *  - search (committed on Enter / Search button)
 *  - an enabled/disabled status filter
 *  - "Add Provider" (opens the create modal)
 *  - "Sync from YAML"
 *  - the create/edit modal itself (FullScreenModal + ReactoryForm)
 *
 * The modal is also opened on demand by other components via the
 * `reactor.AiProviderEditRequested` event - e.g. the grid's add button
 * (reactor.AiProviderWorkflow@1.0.0/addNew), a row Edit action, or the detail
 * panel's Edit button.
 */

interface AiProvidersToolbarDependencies {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
  FullScreenModal: any;
  ReactoryForm: Reactory.Forms.IReactoryFormComponent;
  AiProviderWorkflow: any;
}

interface AiProvidersToolbarProps {
  reactory: Reactory.Client.IReactoryApi;
  loading?: boolean;
  data?: {
    data?: any[];
    paging?: any;
    selected?: any[];
  };
  queryVariables?: {
    filter?: {
      searchString?: string;
      isEnabled?: boolean;
      [key: string]: any;
    };
    paging?: {
      page?: number;
      pageSize?: number;
    };
  };
  searchText?: string;
  onSearchChange?: (text: string) => void;
  onQueryChange?: (queryName: string, variables: any) => void;
  onDataChange?: (data: any[]) => void;
}

const EDIT_REQUESTED_EVENT = 'reactor.AiProviderEditRequested';
const EDIT_FORM = 'reactor.AiProviderEdit@1.0.0';
const CREATE_FORM = 'reactor.AiProviderCreate@1.0.0';

const AiProvidersToolbar = (props: AiProvidersToolbarProps) => {
  const { reactory, data, queryVariables, searchText = '', onSearchChange, onQueryChange, loading } = props;

  const { React, Material, FullScreenModal, ReactoryForm, AiProviderWorkflow } =
    reactory.getComponents<AiProvidersToolbarDependencies>([
      'react.React',
      'material-ui.Material',
      'core.FullScreenModal',
      'core.ReactoryForm',
      'reactor.AiProviderWorkflow',
    ]);

  const activeSearch = queryVariables?.filter?.searchString ?? searchText ?? '';
  const [searchInput, setSearchInput] = React.useState<string>(activeSearch);
  const [modal, setModal] = React.useState<{ open: boolean; mode: 'create' | 'edit'; provider?: any }>({
    open: false,
    mode: 'create',
    provider: null,
  });
  const [editorForm, setEditorForm] = React.useState<any>(null);
  const [saving, setSaving] = React.useState<boolean>(false);

  // Keep the input in step with the committed filter (e.g. after a clear).
  React.useEffect(() => {
    setSearchInput(activeSearch);
  }, [activeSearch]);

  // Open the modal when any component requests an edit/create.
  React.useEffect(() => {
    const handleEditRequest = (request: any) => {
      const mode: 'create' | 'edit' = request?.mode === 'edit' ? 'edit' : 'create';
      setModal({ open: true, mode, provider: request?.provider || null });
    };
    reactory.on(EDIT_REQUESTED_EVENT, handleEditRequest);
    return () => {
      reactory.off(EDIT_REQUESTED_EVENT, handleEditRequest);
    };
  }, [reactory]);

  // Load the (mode specific) editor form definition when the modal opens.
  React.useEffect(() => {
    if (!modal.open) return;
    const formFqn = modal.mode === 'edit' ? EDIT_FORM : CREATE_FORM;
    const definition = reactory.form(
      formFqn,
      (form: any, error?: Error) => {
        setEditorForm(error ? null : form);
      }
    );
    if (definition) setEditorForm(definition);
  }, [modal.open, modal.mode, reactory]);

  const runQuery = (filter: any, page: number) => {
    if (!onQueryChange) return;
    onQueryChange('providers', {
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

  const handleStatusFilter = (value: any) => {
    // `undefined` means "all" - the uiSchema variables map drops undefined keys.
    runQuery({ isEnabled: value }, 1);
  };

  const openCreate = () => setModal({ open: true, mode: 'create', provider: null });
  const closeModal = () => {
    setModal({ open: false, mode: 'create', provider: null });
    setSaving(false);
  };

  const handleSubmit = async (formData: any) => {
    if (!AiProviderWorkflow?.saveProvider) return;
    setSaving(true);
    try {
      const saved = await AiProviderWorkflow.saveProvider({
        mode: modal.mode,
        values: formData,
        provider: modal.provider,
      });
      if (saved) closeModal();
    } finally {
      setSaving(false);
    }
  };

  const handleSync = () => {
    if (AiProviderWorkflow?.syncFromYaml) {
      AiProviderWorkflow.syncFromYaml({ overwrite: true });
    }
  };

  // All hooks have been called - safe to bail out while dependencies load.
  if (!Material || !FullScreenModal) {
    return <>Loading toolbar...</>;
  }

  const { MaterialCore, MaterialIcons } = Material;
  const {
    Box,
    Button,
    Icon,
    Toolbar,
    Tooltip,
    TextField,
    InputAdornment,
    IconButton,
    ButtonGroup,
    Divider,
    Typography,
  } = MaterialCore;
  const { Search: SearchIcon, Clear: ClearIcon } = MaterialIcons || {};

  const statusFilter = queryVariables?.filter?.isEnabled;
  const selectedCount = (data?.selected || []).length;
  const isEdit = modal.mode === 'edit';

  const modalContent = () => {
    if (!editorForm) return <Typography variant="body2">Loading form...</Typography>;
    return (
      <ReactoryForm
        formDef={editorForm}
        formData={isEdit ? modal.provider : { isEnabled: true, roles: ['USER'] }}
        onSubmit={handleSubmit}
      />
    );
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
            placeholder="Search providers by name, id or description..."
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

          <Divider orientation="vertical" flexItem />

          <Typography variant="caption" color="textSecondary">
            Status
          </Typography>
          <ButtonGroup size="small" variant="outlined">
            <Button
              color={statusFilter === undefined ? 'primary' : 'inherit'}
              onClick={() => handleStatusFilter(undefined)}
            >
              All
            </Button>
            <Button
              color={statusFilter === true ? 'primary' : 'inherit'}
              onClick={() => handleStatusFilter(true)}
            >
              Enabled
            </Button>
            <Button
              color={statusFilter === false ? 'primary' : 'inherit'}
              onClick={() => handleStatusFilter(false)}
            >
              Disabled
            </Button>
          </ButtonGroup>

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Synchronise baseline providers from providers.yaml">
            <Button variant="outlined" startIcon={<Icon>sync</Icon>} onClick={handleSync}>
              Sync YAML
            </Button>
          </Tooltip>
          <Tooltip title="Add a new AI provider">
            <Button
              variant="contained"
              color="primary"
              startIcon={<Icon>add</Icon>}
              onClick={openCreate}
              disabled={loading === true}
            >
              Add Provider
            </Button>
          </Tooltip>
        </Box>

        {selectedCount > 0 && (
          <>
            <Divider />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Icon>check_box</Icon>
              <Typography variant="body2" color="textSecondary">
                {selectedCount} provider{selectedCount > 1 ? 's' : ''} selected
              </Typography>
            </Box>
          </>
        )}
      </Toolbar>

      {FullScreenModal && (
        <FullScreenModal
          open={modal.open === true}
          title={isEdit ? `Edit provider: ${modal.provider?.name || modal.provider?.id || ''}` : 'New AI Provider'}
          onClose={closeModal}
        >
          {modal.open === true ? modalContent() : null}
        </FullScreenModal>
      )}
    </>
  );
};

const Definition: any = {
  name: 'AiProvidersToolbar',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiProvidersToolbar,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiProvidersToolbar,
    ['AI Providers', 'Toolbar'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProvidersToolbar,
  });
}

export default AiProvidersToolbar;
