import Reactory from '@reactorynet/reactory-core';

/**
 * GraphQL bindings for the usage dashboard.
 *
 * Reads are served by `ReactorUsageAnalyticsService`, which derives everything
 * from the Postgres conversation message log.
 *
 * `userId` is bound here so the `/admin/ai/usage/:userId` drill-down and the
 * `/profile/usage` self-service view actually scope. It was previously passed as
 * a component prop that no schema or query declared, so it was silently dropped
 * and both routes rendered the global view.
 *
 * `coverage` is surfaced deliberately: it is what lets the dashboard distinguish
 * a complete total from a partial one, and it is the only place the two formerly
 * silent failure modes become visible — a model with no known price (excluded
 * from cost rather than counted as free) and token counts that were estimated
 * rather than reported.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    summary: {
      name: 'ReactorAIUsageSummary',
      text: `query ReactorAIUsageSummary($filter: ReactorUsageFilterInput) {
        ReactorAIUsageSummary(filter: $filter) {
          totalPromptTokens
          totalCompletionTokens
          totalTokens
          totalCostUsdCents
          totalCostUsd
          totalRequests
          avgDurationMs
          errorCount
          timeSeries {
            date
            promptTokens
            completionTokens
            totalTokens
            costUsdCents
            costUsd
            requests
          }
          modelBreakdown {
            model
            provider
            promptTokens
            completionTokens
            totalTokens
            costUsdCents
            costUsd
            requests
          }
          providerBreakdown {
            provider
            totalTokens
            costUsdCents
            costUsd
            requests
          }
          userBreakdown {
            userId
            firstName
            lastName
            email
            totalTokens
            costUsdCents
            costUsd
            requests
          }
          coverage {
            turns
            attributedTurns
            pricedTurns
            unpricedTurns
            estimatedTurns
            zeroUsageTurns
            reroutedTurns
          }
        }
      }`,
      variables: {
        'formData.startDate': 'filter.startDate',
        'formData.endDate': 'filter.endDate',
        'formData.provider': 'filter.provider',
        'formData.model': 'filter.model',
        'formData.personaId': 'filter.personaId',
        'formData.use_case': 'filter.use_case',
        'formData.userId': 'filter.userId',
      },
      resultType: 'object',
      resultMap: {
        'totalPromptTokens': 'totalPromptTokens',
        'totalCompletionTokens': 'totalCompletionTokens',
        'totalTokens': 'totalTokens',
        'totalCostUsd': 'totalCostUsd',
        'totalCostUsdCents': 'totalCostUsdCents',
        'totalRequests': 'totalRequests',
        'avgDurationMs': 'avgDurationMs',
        'errorCount': 'errorCount',
        'timeSeries': 'timeSeries',
        'modelBreakdown': 'modelBreakdown',
        'providerBreakdown': 'providerBreakdown',
        'userBreakdown': 'userBreakdown',
        'coverage': 'coverage',
      },
    },
    userStatus: {
      name: 'ReactorUserUsageStatus',
      text: `query ReactorUserUsageStatus {
        ReactorUserUsageStatus {
          allowed
          status
          percentageUsed
          reason
          budget {
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
          }
        }
      }`,
      resultType: 'object',
      resultMap: {
        'allowed': 'userQuotaAllowed',
        'status': 'userQuotaStatus',
        'percentageUsed': 'userQuotaPercentageUsed',
        'budget': 'userBudget',
      },
    },
    recentRecords: {
      name: 'ReactorAIUsageList',
      text: `query ReactorAIUsageList($filter: ReactorUsageFilterInput, $page: Int, $pageSize: Int) {
        ReactorAIUsageList(filter: $filter, page: $page, pageSize: $pageSize) {
          records {
            id
            userId
            user {
              firstName
              lastName
              email
            }
            personaId
            provider
            model
            promptTokens
            completionTokens
            totalTokens
            costUsd
            durationMs
            use_case
            usageSource
            status
            createdAt
          }
          total
          page
          pageSize
          hasNext
        }
      }`,
      variables: {
        'formData.startDate': 'filter.startDate',
        'formData.endDate': 'filter.endDate',
        'formData.provider': 'filter.provider',
        'formData.model': 'filter.model',
        'formData.personaId': 'filter.personaId',
        'formData.use_case': 'filter.use_case',
        'formData.userId': 'filter.userId',
      },
      resultType: 'object',
      resultMap: {
        'records': 'records',
        'total': 'totalRecords',
      },
    },
  },
};

export default graphql;
