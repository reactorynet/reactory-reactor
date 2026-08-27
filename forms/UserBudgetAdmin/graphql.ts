import Reactory from '@reactorynet/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    budgets: {
      name: 'ReactorUserBudgets',
      text: `query ReactorUserBudgets($filter: ReactorBudgetFilterInput) {
        ReactorUserBudgets(filter: $filter) {
          id
          userId
          user {
            id
            firstName
            lastName
            email
          }
          monthlyTokenLimit
          dailyTokenLimit
          monthlyCostLimitUsd
          dailyCostLimitUsd
          currentMonthTokens
          currentMonthCostUsd
          currentDayTokens
          currentDayCostUsd
          alertThresholdPercent
          hardStop
          status
          lastResetDate
          notes
          updatedAt
        }
      }`,
      resultType: 'array',
      resultMap: {
        '': 'budgets',
      },
    },
  },
  mutation: {
    new: {
      name: 'ReactorSetUserBudget',
      text: `mutation ReactorSetUserBudget($input: ReactorSetUserBudgetInput!) {
        ReactorSetUserBudget(input: $input) {
          id
          userId
          monthlyTokenLimit
          dailyTokenLimit
          monthlyCostLimitUsd
          dailyCostLimitUsd
          alertThresholdPercent
          hardStop
          status
          notes
        }
      }`,
      variables: {
        'formData.userId': 'input.userId',
        'formData.monthlyTokenLimit': 'input.monthlyTokenLimit',
        'formData.dailyTokenLimit': 'input.dailyTokenLimit',
        'formData.monthlyCostLimitUsd': 'input.monthlyCostLimitUsd',
        'formData.dailyCostLimitUsd': 'input.dailyCostLimitUsd',
        'formData.alertThresholdPercent': 'input.alertThresholdPercent',
        'formData.hardStop': 'input.hardStop',
        'formData.notes': 'input.notes',
      },
      resultType: 'object',
      resultMap: {
        'id': 'id',
      },
    },
    edit: {
      name: 'ReactorSetUserBudget',
      text: `mutation ReactorSetUserBudget($input: ReactorSetUserBudgetInput!) {
        ReactorSetUserBudget(input: $input) {
          id
          userId
          monthlyTokenLimit
          dailyTokenLimit
          monthlyCostLimitUsd
          dailyCostLimitUsd
          alertThresholdPercent
          hardStop
          status
          notes
        }
      }`,
      variables: {
        'formData.userId': 'input.userId',
        'formData.monthlyTokenLimit': 'input.monthlyTokenLimit',
        'formData.dailyTokenLimit': 'input.dailyTokenLimit',
        'formData.monthlyCostLimitUsd': 'input.monthlyCostLimitUsd',
        'formData.dailyCostLimitUsd': 'input.dailyCostLimitUsd',
        'formData.alertThresholdPercent': 'input.alertThresholdPercent',
        'formData.hardStop': 'input.hardStop',
        'formData.notes': 'input.notes',
      },
      resultType: 'object',
      resultMap: {
        'id': 'id',
      },
    },
  },
};

export default graphql;
