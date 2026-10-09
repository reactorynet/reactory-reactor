import Reactory from '@reactorynet/reactory-core';

/**
 * No engine-bound GraphQL.
 *
 * The budget widget issues its own queries and mutations directly against the
 * reactor usage resolvers (`ReactorUserBudgetOverview`, `ReactorSetUserBudget`,
 * `ReactorDeleteUserBudget`, `ReactorUserUsageStatus`), so the form carries an
 * empty graph definition — matching the usage-dashboard and compute-dashboard
 * pattern.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {},
  mutations: {},
};

export default graphql;
