import fs from 'fs';
import path from 'path';
import { parse, Source, validateSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

/**
 * The reactor GraphQL schema has to parse and build, or the server fails at
 * boot with a validation error rather than at request time.
 *
 * This exists because a hand edit to ReactorChat.graphql once inserted new
 * types between a type and its own docstring, leaving two consecutive block
 * strings. The file was still readable to a human, and every unit test still
 * passed, because nothing parsed the schema files themselves — the checks in
 * place at the time only parsed extracted fragments, which cannot see a break
 * in the surrounding file.
 */

const SCHEMA_DIR = path.resolve(__dirname, '../../graphql/schema');
const MODULE_DIR = path.resolve(__dirname, '../..');

/** Every .graphql file under a directory. */
const graphqlFiles = (root: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.graphql')) found.push(full);
    }
  };
  walk(root);
  return found;
};

describe('reactor GraphQL schema', () => {
  const files = graphqlFiles(MODULE_DIR);

  it('finds the schema files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(graphqlFiles(MODULE_DIR).map((f) => [path.relative(MODULE_DIR, f), f]))(
    'parses %s',
    (_name, file) => {
      const source = fs.readFileSync(file as string, 'utf8');
      // A syntax error here is a server that will not boot.
      expect(() => parse(new Source(source, file as string))).not.toThrow();
    }
  );

  it('parses when the schema files are concatenated', () => {
    const combined = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(() => parse(new Source(combined, 'combined'))).not.toThrow();
  });

  describe('conversation scoping types', () => {
    // Built the way the server does: an array of typeDefs handed to
    // makeExecutableSchema, which merges and dedupes across modules.
    const buildSchema = () =>
      makeExecutableSchema({
        typeDefs: graphqlFiles(path.resolve(MODULE_DIR, '..')).map((f) =>
          fs.readFileSync(f, 'utf8')
        ),
        resolvers: {},
        resolverValidationOptions: {
          requireResolversForResolveType: 'ignore',
          requireResolversForArgs: 'ignore',
          requireResolversForNonScalar: 'ignore',
        },
      });

    it('builds and validates without errors', () => {
      const schema = buildSchema();
      expect(validateSchema(schema)).toEqual([]);
    });

    it('exposes the edge type with name, value and edge_type', () => {
      const type: any = buildSchema().getType('ReactorConversationEdge');
      expect(Object.keys(type.getFields()).sort()).toEqual(['edge_type', 'name', 'value']);
    });

    it('exposes use_case and edges on the conversation', () => {
      const fields: any = (buildSchema().getType('ReactorChatState') as any).getFields();
      expect(String(fields.use_case.type)).toBe('String');
      expect(String(fields.edges.type)).toBe('[ReactorConversationEdge]');
    });

    it('accepts use_case and edges when filtering conversations', () => {
      const fields: any = (buildSchema().getType('ReactorConversationFilter') as any).getFields();
      expect(String(fields.use_case.type)).toBe('String');
      expect(String(fields.edges.type)).toBe('[ReactorConversationEdgeInput]');
    });

    it('accepts use_case and edges when starting a session', () => {
      // Declared in ReactorPersona.graphql but referencing an input defined in
      // ReactorChat.graphql, so this also proves cross-file resolution works.
      const fields: any = (buildSchema().getType('ReactorInitSession') as any).getFields();
      expect(String(fields.use_case.type)).toBe('String');
      expect(String(fields.edges.type)).toBe('[ReactorConversationEdgeInput]');
    });
  });
});
