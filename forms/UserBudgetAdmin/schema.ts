import Reactory from '@reactorynet/reactory-core';

/**
 * Minimal schema.
 *
 * The screen is a single custom widget mounted on the `dashboard` property, so
 * the schema only needs to declare that object. All filters, limits and metrics
 * live inside the widget; nothing is declared here that could be silently
 * dropped before it renders.
 */
const schema: Reactory.Schema.ISchema = {
  type: 'object',
  title: 'AI Usage Budgets',
  properties: {
    dashboard: {
      type: 'object',
      // No `title`: the widget draws its own header, and a schema title here is
      // what the object template would render above it.
    },
  },
};

export default schema;
