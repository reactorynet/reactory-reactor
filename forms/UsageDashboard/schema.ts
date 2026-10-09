import Reactory from '@reactorynet/reactory-core';

/**
 * Minimal schema.
 *
 * The dashboard is a single custom widget mounted on the `dashboard` property,
 * so the schema only needs to declare that object — exactly as the compute
 * planner dashboard does. All filter inputs and metrics live inside the widget;
 * nothing is declared here that could be silently dropped before it renders.
 */
const schema: Reactory.Schema.ISchema = {
  type: 'object',
  title: 'AI Usage & Telemetry Dashboard',
  properties: {
    dashboard: {
      type: 'object',
      // Deliberately no `title`: the widget renders its own header, and a schema
      // title here is what MaterialObjectTemplate would draw above it.
    },
  },
};

export default schema;
