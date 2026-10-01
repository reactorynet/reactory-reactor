import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiModelOverview@1.0.0
 *
 * Read-only summary of an AI model - the "Overview" tab of
 * reactor.AiModelDetailPanel@1.0.0.
 */

interface AiModelOverviewProps {
  reactory: Reactory.Client.IReactoryApi;
  model: any;
}

const AiModelOverview = (props: AiModelOverviewProps) => {
  const { reactory, model } = props;

  const { React, Material } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
  }>(['react.React', 'material-ui.Material']);

  if (!model) return <div>No model data available</div>;

  const { Box, Typography, Divider } = Material.MaterialCore;

  const format = (value: any): string => {
    if (value === undefined || value === null || value === '') return '-';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return `${value}`;
  };

  const Field = (fieldProps: { label: string; value: any }) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: '1 1 200px', minWidth: 160 }}>
      <Typography variant="caption" color="textSecondary">
        {fieldProps.label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {format(fieldProps.value)}
      </Typography>
    </Box>
  );

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Identity
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Model Key" value={model.id} />
          <Field label="Name" value={model.name} />
          <Field label="Provider" value={model.providerId} />
          <Field label="Version" value={model.version} />
          <Field label="Enabled" value={model.isEnabled === false ? 'Disabled' : 'Enabled'} />
          <Field label="Sort Order" value={model.sortOrder} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Capabilities
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Capabilities" value={model.capabilities} />
          <Field label="Supported Tools" value={model.supportedTools} />
          <Field label="Media Types" value={model.supportedMediaTypes} />
          <Field label="Streaming" value={model.supportsStreaming ? 'Yes' : 'No'} />
        </Box>
      </Box>
    </Box>
  );
};

const Definition: any = {
  name: 'AiModelOverview',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiModelOverview,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiModelOverview,
    ['AI Model'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiModelOverview,
  });
}

export default AiModelOverview;
