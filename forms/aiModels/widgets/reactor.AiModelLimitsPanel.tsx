import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.AiModelLimitsPanel@1.0.0
 *
 * Context window, cost, throughput limits and sampling/thinking support for an
 * AI model - the "Limits &amp; Cost" tab of reactor.AiModelDetailPanel@1.0.0.
 */

interface AiModelLimitsPanelProps {
  reactory: Reactory.Client.IReactoryApi;
  model: any;
}

const AiModelLimitsPanel = (props: AiModelLimitsPanelProps) => {
  const { reactory, model } = props;

  const { React, Material } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
  }>(['react.React', 'material-ui.Material']);

  if (!model) return <div>No model data available</div>;

  const { Box, Typography, Divider } = Material.MaterialCore;

  const format = (value: any, suffix?: string): string => {
    if (value === undefined || value === null || value === '') return '-';
    return suffix ? `${value}${suffix}` : `${value}`;
  };

  const contextLabel = model.contextLength
    ? `${Math.round(Number(model.contextLength) / 1024)}K tokens (${model.contextLength})`
    : 'Dynamic';

  const costLabel = (cents: any): string =>
    cents === undefined || cents === null || cents === ''
      ? '-'
      : `$${(Number(cents) * 10).toFixed(4)} / 1K tokens`;

  const Field = (fieldProps: { label: string; value: any }) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: '1 1 200px', minWidth: 160 }}>
      <Typography variant="caption" color="textSecondary">
        {fieldProps.label}
      </Typography>
      <Typography variant="body2">{format(fieldProps.value)}</Typography>
    </Box>
  );

  const sampling = model.sampling || {};
  const thinking = model.thinking || {};

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Window &amp; Cost
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Context window" value={contextLabel} />
          <Field label="Max output tokens" value={model.maxOutputTokens} />
          <Field label="Input cost" value={costLabel(model.inputCostPerTokenUsdCents)} />
          <Field label="Output cost" value={costLabel(model.outputCostPerTokenUsdCents)} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Throughput Limits
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field label="Requests / minute" value={model.rpm} />
          <Field label="Input tokens / minute" value={model.itpm} />
          <Field label="Output tokens / minute" value={model.otpm} />
          <Field label="Max parallel requests" value={model.maxParallelRequests} />
        </Box>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Advanced Support
        </Typography>
        <Divider sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field
            label="Sampling"
            value={[
              sampling.temperature ? 'temperature' : null,
              sampling.topP ? 'top_p' : null,
              sampling.topK ? 'top_k' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'All supported'}
          />
          <Field label="Thinking mode" value={thinking.mode} />
          <Field label="Thinking effort" value={thinking.effort} />
          <Field label="Thinking display" value={thinking.display} />
        </Box>
      </Box>
    </Box>
  );
};

const Definition: any = {
  name: 'AiModelLimitsPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: AiModelLimitsPanel,
  roles: ['USER'],
};

//@ts-ignore
if (window?.reactory?.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    AiModelLimitsPanel,
    ['AI Model'],
    Definition.roles,
    true,
    [],
    'widget'
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: AiModelLimitsPanel,
  });
}

export default AiModelLimitsPanel;
