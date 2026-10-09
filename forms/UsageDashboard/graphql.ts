import Reactory from '@reactorynet/reactory-core';

/**
 * No engine-bound GraphQL.
 *
 * The dashboard widget issues its own queries directly against the Reactor usage
 * analytics resolvers (`ReactorAIUsageSummary`, `ReactorAIUsageList`,
 * `ReactorUserUsageStatus`). This mirrors the compute planner dashboard, whose
 * form carries an empty graph definition and whose widget fetches its own data.
 *
 * The previous implementation relied on `graphql.query = queries.summary` being
 * set for the page to load at all; that coupling is gone because the widget owns
 * its data lifecycle.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {},
  mutations: {},
};

export default graphql;
