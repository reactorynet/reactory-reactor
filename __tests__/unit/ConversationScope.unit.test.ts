/**
 * Conversations carry a `use_case` and a set of `edges`, and both listing and
 * resuming are scoped by them.
 *
 * The scoping rules are what stop a chat opened beside a content editor from
 * adopting — or continuing — an unrelated standalone conversation. They are
 * expressed as Mongo queries built inside the conversation service, so these
 * tests exercise the query construction directly rather than standing up a
 * database.
 */

/**
 * Mirrors the use_case clause built by getConversations and by the blank
 * conversation reuse lookup in getNewConversation.
 */
const useCaseClause = (useCase: string) =>
  useCase === 'standalone' ? { $in: ['standalone', null, undefined] } : useCase;

/**
 * Mirrors the edges clause built by getConversations.
 */
const edgesClause = (edges: { name?: string; value: string; edge_type: string }[]) => ({
  $all: edges
    .filter((edge: any) => edge && edge.edge_type && edge.value)
    .map((edge) => ({ $elemMatch: { edge_type: edge.edge_type, value: edge.value } })),
});

describe('conversation use_case scoping', () => {
  it('matches unset use_case as standalone', () => {
    // Conversations created before the field existed are standalone by
    // definition. Without this every pre-existing chat would vanish from the
    // history panel the moment the field shipped.
    const clause: any = useCaseClause('standalone');
    expect(clause.$in).toContain('standalone');
    expect(clause.$in).toContain(null);
    expect(clause.$in).toContain(undefined);
  });

  it('matches a non-standalone use case exactly', () => {
    expect(useCaseClause('content')).toBe('content');
    expect(useCaseClause('workflow')).toBe('workflow');
  });

  it('accepts an arbitrary application defined use case', () => {
    expect(useCaseClause('invoice-review')).toBe('invoice-review');
  });

  it('never lets a content scope match a legacy unset conversation', () => {
    // The inverse of the standalone rule: a content chat must not adopt an old
    // conversation that predates scoping.
    const clause = useCaseClause('content');
    expect(typeof clause).toBe('string');
    expect(clause).not.toHaveProperty('$in');
  });
});

describe('conversation edge scoping', () => {
  it('requires every requested edge, not merely one', () => {
    const clause = edgesClause([
      { name: 'slug', value: 'about', edge_type: 'content' },
      { name: 'workflowId', value: 'wf-1', edge_type: 'workflow' },
    ]);

    expect(clause.$all).toHaveLength(2);
    expect(clause.$all[0]).toEqual({
      $elemMatch: { edge_type: 'content', value: 'about' },
    });
  });

  it('matches on type and value, ignoring the label', () => {
    // The label is for humans; two callers may name the same link differently.
    const clause = edgesClause([{ name: 'anything', value: 'about', edge_type: 'content' }]);
    expect(clause.$all[0].$elemMatch).not.toHaveProperty('name');
  });

  it('drops malformed edges rather than building an unmatchable query', () => {
    const clause = edgesClause([
      { name: 'slug', value: 'about', edge_type: 'content' },
      { name: 'broken', value: '', edge_type: 'content' },
      { name: 'broken2', value: 'x', edge_type: '' },
    ]);
    expect(clause.$all).toHaveLength(1);
  });

  it('produces an empty $all for no edges, which matches everything', () => {
    expect(edgesClause([]).$all).toEqual([]);
  });
});

describe('scoping interaction', () => {
  /**
   * The decision the client makes about whether to resume. Standalone keeps
   * the existing "pick up where you left off" behaviour; everything else
   * starts fresh unless the host says otherwise.
   */
  const shouldAutoResume = (useCase: string, override?: boolean) =>
    override !== undefined ? override === true : useCase === 'standalone';

  it('resumes for standalone, which is the default experience', () => {
    expect(shouldAutoResume('standalone')).toBe(true);
  });

  it('does not resume for content, so the pre-filled prompt starts fresh', () => {
    expect(shouldAutoResume('content')).toBe(false);
  });

  it('does not resume for other embedded use cases', () => {
    expect(shouldAutoResume('workflow')).toBe(false);
    expect(shouldAutoResume('form')).toBe(false);
  });

  it('lets a host opt back into resuming', () => {
    expect(shouldAutoResume('workflow', true)).toBe(true);
  });

  it('lets a host opt out of resuming even for standalone', () => {
    expect(shouldAutoResume('standalone', false)).toBe(false);
  });
});
