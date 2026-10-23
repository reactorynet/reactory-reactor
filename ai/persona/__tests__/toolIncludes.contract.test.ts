import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore - js-yaml types are not published for this version
import * as yaml from 'js-yaml';

import { CLIENT_ADVERTISED_TOOL_NAMES } from '../clientTools';
import { BOOKTUTOR_TOOL_INCLUDES } from '../booktutor/toolIncludes';
import { WORKFLOW_TOOL_INCLUDES } from '../workflowwill/toolIncludes';
import { MacroRegistry } from '../../macro';

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

/**
 * The support persona is YAML-only (no `toolIncludes.ts`), so its allowlist is
 * read straight from the file it actually ships. Asserting against a duplicated
 * TS constant would let the two drift, which is the exact failure this guards:
 * a macro can be implemented, exported, registered in both macro index files,
 * and still be invisible because the persona allowlist never names it.
 */
const SUPPORT_PERSONA_YAML = path.join(__dirname, '..', 'support', 'agent.yaml');

const loadSupportToolIncludes = (): string[] => {
  const config: any = yaml.load(fs.readFileSync(SUPPORT_PERSONA_YAML, 'utf8'));
  return config?.tools?.includes ?? [];
};

const SUPPORT_TICKET_TOOL_NAMES = [
  'getSupportTicket',
  'listSupportTickets',
  'createSupportTicket',
  'updateSupportTicket',
  'addSupportTicketComment',
  'getSupportTicketComments',
  'getSupportTicketAttachments',
  'attachSupportTicketFile',
];

const registeredToolNames = (): string[] =>
  MacroRegistry.flatMap((macro) => (macro.tools || []).map((tool: any) => tool?.function?.name)).filter(
    (name): name is string => Boolean(name)
  );

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

describe('support persona tool allowlist', () => {
  it('names every support ticket tool the agent is expected to use', () => {
    const includes = loadSupportToolIncludes();

    expect(
      SUPPORT_TICKET_TOOL_NAMES.filter((name) => !includes.includes(name))
    ).toEqual([]);
  });

  it('resolves all eight support tools through MacroRegistry', () => {
    const includes = loadSupportToolIncludes();
    const registered = registeredToolNames();

    // Every support tool the persona names must exist in the registry, or
    // resolveTools logs "not found" and silently drops it at session creation.
    expect(SUPPORT_TICKET_TOOL_NAMES.filter((name) => !registered.includes(name))).toEqual([]);
    expect(SUPPORT_TICKET_TOOL_NAMES.filter((name) => !includes.includes(name))).toEqual([]);
  });

  it('does not list client-only tools', () => {
    const includes = loadSupportToolIncludes();

    expect(includes.filter((name) => CLIENT_ADVERTISED_TOOL_NAMES.includes(name))).toEqual([]);
  });

  it('does not name a support tool that is absent from MacroRegistry', () => {
    const includes = loadSupportToolIncludes();
    const registered = registeredToolNames();

    // Scoped to the eight support tools on purpose. `resolveTools` consults the
    // core tool registry first and MacroRegistry second, so an entry such as
    // 'graphql' may legitimately resolve outside MacroRegistry; this assertion is
    // only meaningful for the macro tools this ticket owns. An unresolvable
    // include is otherwise dropped at session creation with just a warning.
    expect(SUPPORT_TICKET_TOOL_NAMES.filter((name) => includes.includes(name) && !registered.includes(name))).toEqual([]);
  });
});
