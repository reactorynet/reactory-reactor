/**
 * Drift guard for the reactor module's YAML workflow registry.
 *
 * `workflow/index.ts` is not a list of names: `loadYamlWorkflow` derives the data
 * catalog DESTINATION from the TS arguments, while the workflow's own id is built
 * from the YAML BODY. A body whose version moves without the registry entry (or
 * the other way round) therefore:
 *
 *  - provisions a 1.5.0 definition into `core/ProcessAITicket/1.4.6/...`, leaving a
 *    `location` that does not match the definition's identity and creating no
 *    `1.5.0` catalog path at all;
 *  - registers an id the runner matches verbatim, no longer matching the
 *    `REACTOR_YAML_WORKFLOWS` entry;
 *  - desynchronises any dispatcher constant pinned to the id (for ProcessAITicket
 *    that is `PROCESS_AI_TICKET_WORKFLOW_ID` in the express-server repository,
 *    whose guard test compares itself to this very YAML body).
 *
 * This test reads the registry as SOURCE TEXT rather than importing it, so it
 * needs no module bootstrap and cannot be defeated by a load error. It is the
 * repo-local check that the last two version bumps forgot.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

const WORKFLOW_DIR = path.resolve(__dirname, '..');
const REGISTRY_FILE = path.join(WORKFLOW_DIR, 'index.ts');

interface IRegistryEntry {
  nameSpace: string;
  name: string;
  filename: string;
  version: string;
}

/**
 * Pull `{ nameSpace: '…', name: '…', filename: '…', version: '…' }` literals out of
 * the REACTOR_YAML_WORKFLOWS table, tolerating any key order and whitespace.
 */
const readRegistry = (): IRegistryEntry[] => {
  const source = fs.readFileSync(REGISTRY_FILE, 'utf8');
  const start = source.indexOf('REACTOR_YAML_WORKFLOWS');
  const end = source.indexOf('];', start);
  if (start === -1 || end === -1) throw new Error('REACTOR_YAML_WORKFLOWS table not found in workflow/index.ts');
  const table = source.slice(start, end);

  const entries: IRegistryEntry[] = [];
  const objectPattern = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null = objectPattern.exec(table);
  while (match) {
    const body = match[1];
    const field = (key: string): string => {
      const hit = new RegExp(key + "\\s*:\\s*'([^']*)'").exec(body);
      return hit ? hit[1] : '';
    };
    const entry = { nameSpace: field('nameSpace'), name: field('name'), filename: field('filename'), version: field('version') };
    if (entry.name && entry.filename) entries.push(entry);
    match = objectPattern.exec(table);
  }
  return entries;
};

/** The declared identity of a module YAML file, or null when it is absent. */
const bodyOf = (filename: string): Record<string, any> | null => {
  const file = path.join(WORKFLOW_DIR, filename);
  if (!fs.existsSync(file)) return null;
  return (yaml.load(fs.readFileSync(file, 'utf8')) || {}) as Record<string, any>;
};

const registry = readRegistry();

describe('reactor module workflow registry', () => {
  it('is parsed, so the assertions below cannot pass vacuously', () => {
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.length).toBeGreaterThanOrEqual(10);
    // The entry this repository's AI pipeline depends on, by name.
    expect(registry.filter((entry) => entry.name === 'ProcessAITicket').length).toBe(1);
  });

  it('names a YAML file that exists, and that file declares the same name', () => {
    const problems: string[] = [];
    registry.forEach((entry) => {
      const body = bodyOf(entry.filename);
      if (!body) {
        problems.push(entry.filename + ' is declared in the registry but does not exist');
        return;
      }
      if (String(body.name || '') !== entry.name) {
        problems.push(entry.filename + ': registry name "' + entry.name + '" vs body name "' + String(body.name || '') + '"');
      }
      if (String(body.nameSpace || '') !== entry.nameSpace) {
        problems.push(entry.filename + ': registry nameSpace "' + entry.nameSpace + '" vs body nameSpace "' + String(body.nameSpace || '') + '"');
      }
    });
    expect(problems).toEqual([]);
  });

  it('keeps every declared version identical to the version in its YAML body', () => {
    // The exact drift that put a 1.5.0 body at the 1.4.6 catalog path: the body was
    // bumped and this table was not.
    const problems: string[] = [];
    registry.forEach((entry) => {
      const body = bodyOf(entry.filename);
      if (!body) return;
      const bodyVersion = String(body.version || '').trim();
      if (bodyVersion !== entry.version) {
        problems.push(entry.filename + ': registry version "' + entry.version + '" vs body version "' + bodyVersion + '"');
      }
    });
    expect(problems).toEqual([]);
  });

  it('composes one id per entry, and ProcessAITicket keeps the id the dispatcher pins', () => {
    const ids = registry
      .map((entry) => {
        const body = bodyOf(entry.filename);
        if (!body) return null;
        return body.nameSpace && body.name && body.version ? body.nameSpace + '.' + body.name + '@' + body.version : null;
      })
      .filter((id): id is string => !!id);

    expect(new Set(ids).size).toBe(ids.length);

    // `PROCESS_AI_TICKET_WORKFLOW_ID` (express-server: reactory-core/services/
    // supportWorkflowIds.ts) is what dispatchAiTickets starts and what
    // checkWorkflowRegistered gates on. Its guard test compares the constant to this
    // YAML body, so the two only stay in step while this id is stable.
    expect(ids).toContain('core.ProcessAITicket@1.4.6');
  });
});
