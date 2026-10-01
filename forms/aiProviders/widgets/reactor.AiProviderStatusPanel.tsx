import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiProviderStatusPanel@1.0.0
 *
 * Health, quota and rate-limit view for a provider. Rendered as the "Status" tab
 * of reactor.AiProviderDetailPanel@1.0.0.
 */

interface AiProviderStatusPanelProps {
  reactory: Reactory.Client.IReactoryApi;
  provider: any;
}

const AiProviderStatusPanel = (props: AiProviderStatusPanelProps) => {
  const { reactory, provider } = props;

  const { React, Material } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
  }>(['react.React', 'material-ui.Material']);

  if (!provider) return <div>No provider data available</div>;

  const { Box, Typography, Divider, Button, Icon } = Material.MaterialCore;

  const status = provider.status || {};
  const rateLimits = provider.rateLimits || {};

  const format = (value: any, suffix?: string): string => {
    if (value === undefined || value === null || value === '') return '-';
    return suffix ? `${value}${suffix}` : `${value}`;
  };

  const Field = (fieldProps: { label: string; value: any }) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: '1 1 200px', minWidth: 160 }}>
      <Typography variant="caption" color="textSecondary">
        {fieldProps.label}
      </Typography>
      <Typography variant="body2">{format(fieldProps.value)}</Typography>
    </Box>
  );

  const runTest = () => {
    const workflow = reactory.getComponent<any>('reactor.AiProviderWorkflow@1.0.0');
    if (workflow?.testConnection) {
      workflow.testConnection({ provider });
    }
  };

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="subtitle2">Health</Typography>
        <Box sx={{ flex: 1 }} />
        <Button variant="outlined" size="small" startIcon={<Icon>network_check</Icon>} onClick={runTest}>
          Test Connection
        </Button>
      </Box>
      <Divider />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        <Field label="Available" value={status.available ? 'Online' : 'Offline'} />
        <Field label="Uptime" value={format(status.uptime, '%')} />
        <Field label="Response time" value={format(status.responseTime, ' ms')} />
        <Field label="Error rate" value={format(status.errorRate, '%')} />
        <Field label="Quota remaining" value={status.quotaRemaining} />
        <Field
          label="Last checked"
          value={status.lastChecked ? new Date(status.lastChecked).toLocaleString() : '-'}
        />
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
  name: 'AiProviderStatusPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiProviderStatusPanel,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiProviderStatusPanel,
    ['AI Provider'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiProviderStatusPanel,
  });
}

export default AiProviderStatusPanel;
