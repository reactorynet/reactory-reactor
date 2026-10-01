import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiProviderModelsPanel@1.0.0
 *
 * Read-only listing of the models registered against a provider. Rendered as the
 * "Models" tab of reactor.AiProviderDetailPanel@1.0.0.
 *
 * Models are created, edited and deleted from the AI Models grid
 * (reactor.AiModelsGrid@1.0.0), which owns the model CRUD workflow and editor.
 * Keeping this panel read-only avoids coupling the providers form to the models
 * workflow/editor widgets.
 */

interface AiProviderModelsPanelProps {
  reactory: Reactory.Client.IReactoryApi;
  provider: any;
}

const AiProviderModelsPanel = (props: AiProviderModelsPanelProps) => {
  const { reactory, provider } = props;

  const { React, Material } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
  }>(['react.React', 'material-ui.Material']);

  if (!provider) return <div>No provider data available</div>;

  const { Box, Typography, Divider } = Material.MaterialCore;

  const models: any[] = Array.isArray(provider.models) ? provider.models : [];

  const formatContext = (contextLength: any): string =>
    contextLength ? `${Math.round(Number(contextLength) / 1024)}K tokens` : 'Dynamic';

  const formatCost = (cents: any): string =>
    cents === undefined || cents === null || cents === '' ? '-' : `$${(Number(cents) * 10).toFixed(4)} / 1K`;

  if (models.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="textSecondary">
          No models are registered against this provider. Add models from the AI Models screen.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2">
        {models.length} model{models.length > 1 ? 's' : ''}
      </Typography>
      <Divider />

      {models.map((model: any) => (
        <Box
          key={`${provider.id}:${model.id}`}
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 2,
            alignItems: 'center',
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box sx={{ flex: '1 1 220px', minWidth: 180 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {model.name}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              {model.id}
              {model.version ? ` · v${model.version}` : ''}
            </Typography>
          </Box>
          <Box sx={{ flex: '0 1 140px' }}>
            <Typography variant="caption" color="textSecondary">
              Context
            </Typography>
            <Typography variant="body2">{formatContext(model.contextLength)}</Typography>
          </Box>
          <Box sx={{ flex: '0 1 130px' }}>
            <Typography variant="caption" color="textSecondary">
              Streaming
            </Typography>
            <Typography variant="body2">{model.supportsStreaming ? 'Yes' : 'No'}</Typography>
          </Box>
          <Box sx={{ flex: '0 1 150px' }}>
            <Typography variant="caption" color="textSecondary">
              Input cost
            </Typography>
            <Typography variant="body2">{formatCost(model.inputCostPerTokenUsdCents)}</Typography>
          </Box>
          <Box sx={{ flex: '0 1 150px' }}>
            <Typography variant="caption" color="textSecondary">
              Output cost
            </Typography>
            <Typography variant="body2">{formatCost(model.outputCostPerTokenUsdCents)}</Typography>
          </Box>
          <Box sx={{ flex: '0 1 110px' }}>
            <Typography variant="caption" color="textSecondary">
              Enabled
            </Typography>
            <Typography variant="body2">{model.isEnabled === false ? 'No' : 'Yes'}</Typography>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

const Definition: any = {
  name: 'AiProviderModelsPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiProviderModelsPanel,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiProviderModelsPanel,
    ['AI Provider'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProviderModelsPanel,
  });
}

export default AiProviderModelsPanel;
