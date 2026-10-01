import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiModelDetailPanel@1.0.0
 *
 * Expanded-row detail panel for the AI Models grid, wired via
 * `ui:options.componentMap.DetailsPanel` and
 * `detailPanelPropsMap: { 'props.rowData': 'model' }`.
 *
 * Tabs: Overview (reactor.AiModelOverview) and Limits & Cost
 * (reactor.AiModelLimitsPanel). Header actions: Edit (opens the modal editor via
 * the workflow) and Delete.
 */

interface AiModelDetailPanelProps {
  reactory: Reactory.Client.IReactoryApi;
  model?: any;
  rowData?: any;
  useCase?: string;
}

interface DetailPanelDependencies {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
  AiModelOverview: any;
  AiModelLimitsPanel: any;
}

const lastActiveTabByModel: { [modelKey: string]: number } = {};

const AiModelDetailPanel = (props: AiModelDetailPanelProps) => {
  const { reactory, model: initialModel, rowData, useCase = 'grid' } = props;
  const modelSeed = initialModel || rowData;

  const { React, Material, AiModelOverview, AiModelLimitsPanel } = reactory.getComponents<DetailPanelDependencies>([
    'react.React',
    'material-ui.Material',
    'reactor.AiModelOverview',
    'reactor.AiModelLimitsPanel',
  ]);

  const [model, setModel] = React.useState<any>(modelSeed);
  const [refreshToken, setRefreshToken] = React.useState<number>(0);

  React.useEffect(() => {
    setModel(modelSeed);
  }, [modelSeed?.id, modelSeed?.providerId]);

  React.useEffect(() => {
    const handleModelChanged = (event: any) => {
      if (event && event.modelId && modelSeed?.id && event.modelId !== modelSeed.id) return;
      if (event && event.model) {
        setModel((previous: any) => ({ ...previous, ...event.model }));
      }
      setRefreshToken((token) => token + 1);
    };
    reactory.on('reactor.AiModelChanged', handleModelChanged);
    return () => {
      reactory.off('reactor.AiModelChanged', handleModelChanged);
    };
  }, [modelSeed?.id, reactory]);

  if (!model) return <div>No model data available</div>;

  const { Box, Tabs, Tab, Typography, Icon, Button, Divider } = Material.MaterialCore;

  const workflow: any = reactory.getComponent('reactor.AiModelWorkflow@1.0.0');

  const [activeTab, setActiveTab] = React.useState<number>(() => lastActiveTabByModel[model.id] ?? 0);

  const handleTabChange = (_event: any, newValue: number) => {
    lastActiveTabByModel[model.id] = newValue;
    setActiveTab(newValue);
  };

  const handleEdit = () => {
    if (workflow?.editModel) workflow.editModel({ model });
  };

  const handleDelete = () => {
    if (workflow?.delete && window.confirm(`Delete model "${model.name || model.id}"?`)) {
      workflow.delete({ model });
    }
  };

  const tabs = [
    { id: 'overview', label: 'Overview', icon: 'info', Component: AiModelOverview },
    { id: 'limits', label: 'Limits & Cost', icon: 'speed', Component: AiModelLimitsPanel },
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
            {model.name || model.id}
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            {model.id}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            provider: {model.providerId}
          </Typography>
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, color: model.isEnabled === false ? 'text.disabled' : 'success.main' }}
          >
            {model.isEnabled === false ? 'Disabled' : 'Enabled'}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
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
              icon={<Icon>{tab.icon}</Icon>}
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
          <ActiveTab key={`${model.id}:${refreshToken}`} model={model} reactory={reactory} useCase={useCase} />
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
  name: 'AiModelDetailPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiModelDetailPanel,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiModelDetailPanel,
    ['AI Model'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiModelDetailPanel,
  });
}

export default AiModelDetailPanel;
