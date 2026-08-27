import Reactory from '@reactorynet/reactory-core';

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
        }
      }`,
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
            status
            createdAt
          }
          total
          page
          pageSize
          hasNext
        }
      }`,
      resultType: 'object',
      resultMap: {
        'records': 'records',
        'total': 'totalRecords',
      },
    },
  },
};

export default graphql;
