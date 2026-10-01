import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiProviderDetailPanel@1.0.0
 *
 * Expanded-row detail panel for the AI Providers grid, wired via
 * `ui:options.componentMap.DetailsPanel` and `detailPanelPropsMap`
 * ({ 'props.rowData': 'provider' }).
 *
 * Tabs: Overview (reactor.AiProviderOverview), Models
 * (reactor.AiProviderModelsPanel) and Status (reactor.AiProviderStatusPanel).
 * Header actions: Edit (opens the modal editor via the workflow), Test
 * Connection and Delete.
 *
 * Editing uses the modal pattern (FullScreenModal + ReactoryForm) hosted by
 * reactor.AiProvidersToolbar@1.0.0 - the panel raises
 * `reactor.AiProviderEditRequested` rather than rendering its own form.
 */

interface AiProviderDetailPanelProps {
  reactory: Reactory.Client.IReactoryApi;
  provider?: any;
  rowData?: any;
  useCase?: string;
}

interface DetailPanelDependencies {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
  AiProviderOverview: any;
  AiProviderModelsPanel: any;
  AiProviderStatusPanel: any;
}

/** Remembers the selected tab per provider for the session so a grid refresh
 * (which remounts the panel) does not reset the user back to the first tab. */
const lastActiveTabByProvider: { [providerId: string]: number } = {};

const AiProviderDetailPanel = (props: AiProviderDetailPanelProps) => {
  const { reactory, provider: initialProvider, rowData, useCase = 'grid' } = props;
  const providerSeed = initialProvider || rowData;

  const { React, Material, AiProviderOverview, AiProviderModelsPanel, AiProviderStatusPanel } =
    reactory.getComponents<DetailPanelDependencies>([
      'react.React',
      'material-ui.Material',
      'reactor.AiProviderOverview',
      'reactor.AiProviderModelsPanel',
      'reactor.AiProviderStatusPanel',
    ]);

  const [provider, setProvider] = React.useState<any>(providerSeed);
  const [refreshToken, setRefreshToken] = React.useState<number>(0);

  React.useEffect(() => {
    setProvider(providerSeed);
  }, [providerSeed?.id]);

  React.useEffect(() => {
    const handleProviderChanged = (event: any) => {
      if (event && event.providerId && providerSeed?.id && event.providerId !== providerSeed.id) return;
      if (event && event.provider) {
        setProvider((previous: any) => ({ ...previous, ...event.provider }));
      }
      setRefreshToken((token) => token + 1);
    };
    reactory.on('reactor.AiProviderChanged', handleProviderChanged);
    return () => {
      reactory.off('reactor.AiProviderChanged', handleProviderChanged);
    };
  }, [providerSeed?.id, reactory]);

  if (!provider) return <div>No provider data available</div>;

  const { Box, Tabs, Tab, Typography, Icon, Button, Badge, Divider } = Material.MaterialCore;

  const workflow: any = reactory.getComponent('reactor.AiProviderWorkflow@1.0.0');

  const [activeTab, setActiveTab] = React.useState<number>(
    () => lastActiveTabByProvider[provider.id] ?? 0
  );

  const handleTabChange = (_event: any, newValue: number) => {
    lastActiveTabByProvider[provider.id] = newValue;
    setActiveTab(newValue);
  };

  const handleEdit = () => {
    if (workflow?.editProvider) workflow.editProvider({ provider });
  };

  const handleTest = () => {
    if (workflow?.testConnection) workflow.testConnection({ provider });
  };

  const handleDelete = () => {
    // eslint-disable-next-line no-alert
    if (workflow?.delete && window.confirm(`Delete provider "${provider.name || provider.id}"?`)) {
      workflow.delete({ provider });
    }
  };

  const models = Array.isArray(provider.models) ? provider.models : [];
  const isEnabled = provider.isEnabled !== false;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: 'info', badge: 0, Component: AiProviderOverview },
    { id: 'models', label: 'Models', icon: 'memory', badge: models.length, Component: AiProviderModelsPanel },
    { id: 'status', label: 'Status', icon: 'monitor_heart', badge: 0, Component: AiProviderStatusPanel },
  ];

  const ActiveTab = tabs[activeTab]?.Component;

  return (
    <Box sx={{ width: '100%', bgcolor: 'background.paper' }}>
      {/* Header */}
      <Box
        sx={{
          p: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          borderBottom: 1,
          borderColor: 'divider',
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {provider.name || provider.id}
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            ({provider.id})
          </Typography>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              color: isEnabled ? 'success.main' : 'text.disabled',
            }}
          >
            {isEnabled ? 'Enabled' : 'Disabled'}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button size="small" startIcon={<Icon>network_check</Icon>} onClick={handleTest}>
            Test
          </Button>
          <Button size="small" variant="contained" startIcon={<Icon>edit</Icon>} onClick={handleEdit}>
            Edit
          </Button>
          <Button size="small" color="error" startIcon={<Icon>delete</Icon>} onClick={handleDelete}>
            Delete
          </Button>
        </Box>
      </Box>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={activeTab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              icon={
                tab.badge > 0 ? (
                  <Badge badgeContent={tab.badge} color="primary">
                    <Icon>{tab.icon}</Icon>
                  </Badge>
                ) : (
                  <Icon>{tab.icon}</Icon>
                )
              }
              label={tab.label}
              iconPosition="start"
              sx={{ minHeight: 56, textTransform: 'none', fontSize: '0.875rem' }}
            />
          ))}
        </Tabs>
      </Box>

      {/* Active tab */}
      <Box sx={{ p: 0 }}>
        {ActiveTab ? (
          <ActiveTab key={`${provider.id}:${refreshToken}`} provider={provider} reactory={reactory} useCase={useCase} />
        ) : (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="textSecondary">
              This section is unavailable.
            </Typography>
          </Box>
        )}
      </Box>
      <Divider />
    </Box>
  );
};

const Definition: any = {
  name: 'AiProviderDetailPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiProviderDetailPanel,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiProviderDetailPanel,
    ['AI Provider'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProviderDetailPanel,
  });
}

export default AiProviderDetailPanel;
