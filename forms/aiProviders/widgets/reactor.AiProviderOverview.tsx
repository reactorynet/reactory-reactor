import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiProviderOverview@1.0.0
 *
 * Read-only summary of an AI provider, rendered as the "Overview" tab of
 * reactor.AiProviderDetailPanel@1.0.0. Editing happens through the modal
 * editor (reactor.AiProviderEdit@1.0.0) via the panel header's Edit action.
 */

interface AiProviderOverviewProps {
  reactory: Reactory.Client.IReactoryApi;
  provider: any;
}

const AiProviderOverview = (props: AiProviderOverviewProps) => {
  const { reactory, provider } = props;

  const { React, Material } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
  }>(['react.React', 'material-ui.Material']);

  if (!provider) return <div>No provider data available</div>;

  const { Box, Typography, Divider } = Material.MaterialCore;

  const format = (value: any): string => {
    if (value === undefined || value === null || value === '') return '-';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return `${value}`;
  };

  const Field = (fieldProps: { label: string; value: any }) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: '1 1 220px', minWidth: 180 }}>
      <Typography variant="caption" color="textSecondary">
        {fieldProps.label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {format(fieldProps.value)}
      </Typography>
    </Box>
  );

  const rateLimits = provider.rateLimits || {};
  const models = Array.isArray(provider.models) ? provider.models : [];

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Identity
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Provider ID" value={provider.id} />
          <Field label="Name" value={provider.name} />
          <Field label="Type" value={provider.providerType || provider.id} />
          <Field label="Enabled" value={provider.isEnabled === false ? 'Disabled' : 'Enabled'} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Description
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Typography variant="body2" color={provider.description ? 'textPrimary' : 'textSecondary'}>
          {provider.description || 'No description provided.'}
        </Typography>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Connection
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Endpoint URL" value={provider.endpointUrl || 'Default provider API'} />
          <Field label="API Version" value={provider.apiVersion} />
          <Field label="Auth Component" value={provider.authComponentFqn} />
          <Field label="Default Model" value={provider.defaultModel} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Capabilities &amp; Access
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Capabilities" value={provider.capabilities} />
          <Field label="Roles" value={provider.roles} />
          <Field label="Credential Requirements" value={provider.credentialRequirements} />
          <Field label="Models" value={`${models.length} configured`} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Rate Limits
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Requests / minute" value={rateLimits.requestsPerMinute} />
          <Field label="Tokens / minute" value={rateLimits.tokensPerMinute} />
          <Field label="Concurrent requests" value={rateLimits.concurrentRequests} />
        </Box>
      </Box>
    </Box>
  );
};

const Definition: any = {
  name: 'AiProviderOverview',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiProviderOverview,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiProviderOverview,
    ['AI Provider'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProviderOverview,
  });
}

export default AiProviderOverview;
