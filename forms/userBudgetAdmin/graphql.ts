import Reactory from '@reactorynet/reactory-core';

/**
 * Loads the user's current budget when `formData.userId` changes. The result
 * is mapped onto the form fields directly, so the form acts as both viewer and editor.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {
    name: 'ReactorUserBudget',
    text: `query ReactorUserBudget($userId: ObjID!) {
      ReactorUserBudget(userId: $userId) {
        id
        userId
        active
        timezone
        weekStartsOn
        day { limitUsdCents softThresholdPct hardBlock }
        week { limitUsdCents softThresholdPct hardBlock }
        month { limitUsdCents softThresholdPct hardBlock }
        scope { providerIds modelIds }
        pricingOverrides {
          providerId
          modelId
          inputPerTokenUsdCents
          outputPerTokenUsdCents
          cachedInputPerTokenUsdCents
          cacheWritePerTokenUsdCents
          reasoningPerTokenUsdCents
          imageGenerationPerImageUsdCents
        }
      }
    }`,
    variables: {
      'formData.userId': 'userId',
    },
    resultType: 'object',
    resultMap: {
      'userId': 'userId',
      'active': 'active',
      'timezone': 'timezone',
      'weekStartsOn': 'weekStartsOn',
      'day.limitUsdCents': 'day.limitUsdCents',
      'day.softThresholdPct': 'day.softThresholdPct',
      'day.hardBlock': 'day.hardBlock',
      'week.limitUsdCents': 'week.limitUsdCents',
      'week.softThresholdPct': 'week.softThresholdPct',
      'week.hardBlock': 'week.hardBlock',
      'month.limitUsdCents': 'month.limitUsdCents',
      'month.softThresholdPct': 'month.softThresholdPct',
      'month.hardBlock': 'month.hardBlock',
      'scope.providerIds': 'scope.providerIds',
      'scope.modelIds': 'scope.modelIds',
      'pricingOverrides': 'pricingOverrides',
    },
    autoQuery: true,
    queryMessage: 'Loading user budget...',
  },
  mutation: {
    new: {
      name: 'ReactorSetUserBudget',
      text: `mutation ReactorSetUserBudget($input: ReactorSetUserBudgetInput!) {
        ReactorSetUserBudget(input: $input) {
          id
          userId
          active
        }
      }`,
      variables: {
        'formData.userId': 'input.userId',
        'formData.active': 'input.active',
        'formData.timezone': 'input.timezone',
        'formData.weekStartsOn': 'input.weekStartsOn',
        'formData.day.limitUsdCents': 'input.day.limitUsdCents',
        'formData.day.softThresholdPct': 'input.day.softThresholdPct',
        'formData.day.hardBlock': 'input.day.hardBlock',
        'formData.week.limitUsdCents': 'input.week.limitUsdCents',
        'formData.week.softThresholdPct': 'input.week.softThresholdPct',
        'formData.week.hardBlock': 'input.week.hardBlock',
        'formData.month.limitUsdCents': 'input.month.limitUsdCents',
        'formData.month.softThresholdPct': 'input.month.softThresholdPct',
        'formData.month.hardBlock': 'input.month.hardBlock',
        'formData.scope': 'input.scope',
        'formData.pricingOverrides': 'input.pricingOverrides',
      },
      onSuccessMethod: 'notification',
      notification: {
        title: 'Budget saved',
        type: 'success',
      },
      onError: {
        componentRef: 'core.NotificationComponent',
        method: 'show',
        notification: {
          title: 'Failed to save budget',
          type: 'error',
        },
      },
    },
    delete: {
      name: 'ReactorClearUserBudget',
      text: `mutation ReactorClearUserBudget($userId: ObjID!) {
        ReactorClearUserBudget(userId: $userId)
      }`,
      variables: {
        'formData.userId': 'userId',
      },
      onSuccessMethod: 'notification',
      notification: {
        title: 'Budget cleared',
        type: 'success',
      },
    },
  },
};

export default graphql;
