import ReactorConversationModel from '../ReactorChatState';

/**
 * `vars` must be a tracked `Mixed` path.
 *
 * It was declared `vars: {}` — a nested path with no sub-fields, which Mongoose does not
 * track. Arbitrary keys written into it (delegation records, todo lists, user variables)
 * were then fragile under save/normalisation, contributing to the delegation record losing
 * its identifying fields. `Mixed` stores them verbatim.
 */
describe('ReactorChatState schema - vars', () => {
  it('declares `vars` as a Mixed path', () => {
    const varsPath: any = ReactorConversationModel.schema.path('vars');
    expect(varsPath).toBeDefined();
    expect(varsPath.instance).toBe('Mixed');
  });

  it('honours arbitrary nested keys (a delegation record round-trips)', () => {
    const record = {
      subagent_delegations: {
        'del-1': {
          status: 'complete',
          personaId: 'daan',
          agentName: 'Docent Daan',
          subagentSessionId: 'a'.repeat(24),
          parentSessionId: 'b'.repeat(24),
          message: 'do work',
          startedAt: '2026-10-12T09:00:00.000Z',
          response: 'done',
          completedAt: '2026-10-12T09:00:05.000Z',
        },
      },
    };

    const doc: any = new ReactorConversationModel({ personaId: 'ReactorAIPersona', vars: record });
    // Mongoose casts to plain data on serialisation; the nested structure must survive.
    const plain = doc.toObject({ depopulate: true, flattenMaps: true });
    expect(plain.vars).toEqual(record);
  });
});
