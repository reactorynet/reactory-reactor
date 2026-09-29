import Reactory from '@reactorynet/reactory-core';

/**
 * GraphQL bindings for AI usage budget administration.
 *
 * Three things this form has to support, and the query/mutation each one needs:
 *
 *  - **Create and edit** a budget: `save` → `ReactorSetUserBudget`. That mutation
 *    upserts by `userId`, so "edit" is the same call as "create" with the user
 *    already selected — there is no separate update path to drift out of sync.
 *  - **Remove** a budget: `delete` → `ReactorDeleteUserBudget`, invoked from the
 *    overview table's row action.
 *  - **See who has a budget and who does not**: `overview` →
 *    `ReactorUserBudgetOverview`. The previous binding used `ReactorUserBudgets`,
 *    which can only ever list users who *already* have a budget — so the absence
 *    of a row was indistinguishable from a page that had failed to load, and the
 *    question "which users have no budget?" had no answer at all.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    overview: {
      name: 'ReactorUserBudgetOverview',
      text: `query ReactorUserBudgetOverview($filter: ReactorBudgetOverviewFilterInput) {
        ReactorUserBudgetOverview(filter: $filter) {
          userId
          hasBudget
          monthlyTokenLimit
          dailyTokenLimit
          monthlyCostLimitUsd
          dailyCostLimitUsd
          alertThresholdPercent
          hardStop
          notes
          currentMonthTokens
          currentMonthCostUsd
          currentDayTokens
          currentDayCostUsd
          status
          user {
            id
            firstName
            lastName
            email
          }
          budget {
            id
            userId
            status
            updatedAt
          }
        }
      }`,
      variables: {
        'formData.search': 'filter.search',
        'formData.onlyUnbudgeted': 'filter.onlyUnbudgeted',
        'formData.onlyBudgeted': 'filter.onlyBudgeted',
      },
      resultType: 'array',
      resultMap: {
        '': 'userBudgets',
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
      notification: {
        title: 'Budget saved for ${result.data.ReactorSetUserBudget.userId}',
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
      notification: {
        title: 'Budget updated for ${result.data.ReactorSetUserBudget.userId}',
      },
    },
    /**
     * Remove a budget.
     *
     * Wired to the overview table's row action, which passes the checked rows as
     * `selected`. `selected[0]` is intentional: the action deletes one budget at a
     * time, and naming a single row is what makes that explicit rather than
     * looping over a selection whose other rows the operator did not intend.
     */
    delete: {
      name: 'ReactorDeleteUserBudget',
      text: `mutation ReactorDeleteUserBudget($id: String!) {
        ReactorDeleteUserBudget(id: $id)
      }`,
      variables: {
        'selected[0].budget.id': 'id',
      },
      resultType: 'boolean',
      notification: {
        title: 'Budget removed',
      },
    },
  },
};

export default graphql;
