import Reactory from '@reactorynet/reactory-core';

const periodSchema: Reactory.Schema.IObjectSchema = {
  type: 'object',
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Enabled',
      default: false,
    },
    limitUsdCents: {
      type: 'number',
      title: 'Limit (USD cents)',
      description: 'Spending cap for the period. Stored as float USD cents (e.g. 5000 = $50.00).',
      minimum: 0,
      default: 0,
    },
    softThresholdPct: {
      type: 'number',
      title: 'Soft warning threshold (%)',
      description: 'Percent of limit that triggers a soft-warn alert (still allowed through).',
      minimum: 0,
      maximum: 100,
      default: 80,
    },
    hardBlock: {
      type: 'boolean',
      title: 'Hard block when over limit',
      default: true,
    },
  },
};

const pricingOverrideSchema: Reactory.Schema.IObjectSchema = {
  type: 'object',
  required: ['providerId', 'modelId'],
  properties: {
    providerId: {
      type: 'string',
      title: 'Provider ID',
    },
    modelId: {
      type: 'string',
      title: 'Model ID',
    },
    inputPerTokenUsdCents: {
      type: ['number', 'null'],
      title: 'Input per-token (USD cents)',
    },
    outputPerTokenUsdCents: {
      type: ['number', 'null'],
      title: 'Output per-token (USD cents)',
    },
    cachedInputPerTokenUsdCents: {
      type: ['number', 'null'],
      title: 'Cached input per-token (USD cents)',
    },
    cacheWritePerTokenUsdCents: {
      type: ['number', 'null'],
      title: 'Cache write per-token (USD cents)',
    },
    reasoningPerTokenUsdCents: {
      type: ['number', 'null'],
      title: 'Reasoning per-token (USD cents)',
    },
    imageGenerationPerImageUsdCents: {
      type: ['number', 'null'],
      title: 'Image generation per-image (USD cents)',
    },
  },
};

const schema: Reactory.Schema.ISchema = {
  type: 'object',
  required: ['userId'],
  properties: {
    userId: {
      type: 'string',
      title: 'User',
      description: 'The user whose budget you are editing.',
    },
    active: {
      type: 'boolean',
      title: 'Budget active',
      description: 'When false, the budget is treated as if it does not exist (no enforcement).',
      default: true,
    },
    timezone: {
      type: 'string',
      title: 'Timezone (IANA)',
      description: 'Used to compute day/week/month period boundaries (e.g. Africa/Johannesburg).',
      default: 'UTC',
    },
    weekStartsOn: {
      type: 'string',
      title: 'Week starts on',
      enum: ['mon', 'sun'],
      default: 'mon',
    },
    day: periodSchema,
    week: periodSchema,
    month: periodSchema,
    scope: {
      type: 'object',
      title: 'Scope (optional)',
      description: 'Restrict the budget to specific providers or models. Leave empty to apply to all.',
      properties: {
        providerIds: {
          type: 'array',
          title: 'Provider IDs',
          items: { type: 'string' },
        },
        modelIds: {
          type: 'array',
          title: 'Model IDs',
          items: { type: 'string' },
        },
      },
    },
    pricingOverrides: {
      type: 'array',
      title: 'Pricing overrides',
      description: 'Per-(provider,model) overrides. Useful for unpriced YAML entries (e.g. Azure deployments billed via subscription).',
      items: pricingOverrideSchema,
    },
  },
};

export default schema;
