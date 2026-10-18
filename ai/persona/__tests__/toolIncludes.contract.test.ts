import { CLIENT_ADVERTISED_TOOL_NAMES } from '../clientTools';
import { BOOKTUTOR_TOOL_INCLUDES } from '../booktutor/toolIncludes';
import { WORKFLOW_TOOL_INCLUDES } from '../workflowwill/toolIncludes';

/**
 * Persona tool-include lists are matched against `MacroRegistry`. Client tools
 * have no registry entry — the browser advertises them at session creation via
 * `syncClientCapabilities` — so naming them here never adds anything. It reads
 * as if it did, which is exactly the confusion that made the image macro look
 * like a missing registration.
 */
const PERSONA_TOOL_INCLUDES: Record<string, string[]> = {
  BookTutor: BOOKTUTOR_TOOL_INCLUDES,
  WorkflowWill: WORKFLOW_TOOL_INCLUDES,
};

describe('persona tool-include lists', () => {
  it('documents the client-advertised tool set', () => {
    expect(CLIENT_ADVERTISED_TOOL_NAMES).toEqual(['form', 'component', 'chart', 'd3', 'image']);
  });

  it.each(Object.entries(PERSONA_TOOL_INCLUDES))(
    '%s does not list client-only tools',
    (_persona, includes) => {
      expect(includes.filter((name) => CLIENT_ADVERTISED_TOOL_NAMES.includes(name))).toEqual([]);
    }
  );
});
