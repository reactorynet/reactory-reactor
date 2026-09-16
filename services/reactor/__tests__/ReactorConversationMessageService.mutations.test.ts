import ReactorConversationMessageService from '../ReactorConversationMessageService';

/**
 * Unit coverage for the Phase 3 step 3b mutation mirror primitives.
 *
 * The mutating conversation paths (`deleteToolCall`, `updateToolCallStatus`,
 * `rateMessage`, `patchSystemPrompt`) historically wrote Mongo only, so under
 * `REACTOR_MESSAGES_SOURCE=postgres` the change was invisible. These tests pin
 * the message-store half of that mirror: that a mutation reaches the row keyed
 * on `mongo_id`, and — importantly — that it cannot clobber an archived row or
 * reassign ordering, which a naive "write the whole item" would do.
 *
 * A fake DataSource/repository is injected via the constructor rather than a
 * real connection, so these run anywhere.
 */

const MONGO_ID = 'a'.repeat(24);
const CONVERSATION_ID = 'c'.repeat(24);

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  update: jest.fn(async () => ({ affected: 1 })),
  delete: jest.fn(async () => ({ affected: 1 })),
  query: jest.fn(async () => [] as unknown[]),
  ...overrides,
});

const makeService = (repo: any) => {
  const dataSource: any = { isInitialized: true, getRepository: () => repo };
  return new ReactorConversationMessageService(dataSource);
};

const makeUnavailableService = () => {
  const dataSource: any = {
    isInitialized: false,
    getRepository: () => {
      throw new Error('not initialised');
    },
  };
  return new ReactorConversationMessageService(dataSource);
};

describe('ReactorConversationMessageService mutation mirror', () => {
  describe('updateMessageByMongoId', () => {
    it('updates the row keyed on the mongo id, not the internal row id', async () => {
      const repo = makeRepo();
      const service = makeService(repo);

      const updated = await service.updateMessageByMongoId(MONGO_ID, {
        _id: MONGO_ID,
        role: 'assistant',
        content: 'edited',
        rating: 1,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });

      expect(updated).toBe(true);
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [criteria] = repo.update.mock.calls[0] as any[];
      expect(criteria).toEqual({ mongoId: MONGO_ID });
    });

    it('never writes identity or archival lifecycle columns', async () => {
      const repo = makeRepo();
      const service = makeService(repo);

      await service.updateMessageByMongoId(MONGO_ID, {
        _id: MONGO_ID,
        role: 'assistant',
        content: 'edited',
        rating: 1,
        // A Mongo history item does not carry archival state. If these leaked
        // into the patch, a mutation would silently un-archive a displaced row.
        archived: true,
        archivedReason: 'truncated',
      });

      const [, patch] = repo.update.mock.calls[0] as any[];
      expect(patch).not.toHaveProperty('mongoId');
      expect(patch).not.toHaveProperty('conversationId');
      expect(patch).not.toHaveProperty('seq');
      expect(patch).not.toHaveProperty('archived');
      expect(patch).not.toHaveProperty('archivedAt');
      expect(patch).not.toHaveProperty('archivedReason');
    });

    it('refreshes the search index along with the mutated content', async () => {
      const repo = makeRepo();
      const service = makeService(repo);

      await service.updateMessageByMongoId(MONGO_ID, {
        _id: MONGO_ID,
        role: 'assistant',
        content: 'a newly searchable phrase',
      });

      const [, patch] = repo.update.mock.calls[0] as any[];
      expect(patch.searchText).toContain('a newly searchable phrase');
    });

    it('is a no-op when the store is unavailable or the id is missing', async () => {
      const unavailable = makeUnavailableService();
      await expect(
        unavailable.updateMessageByMongoId(MONGO_ID, { role: 'assistant' })
      ).resolves.toBe(false);

      const repo = makeRepo();
      const service = makeService(repo);
      await expect(service.updateMessageByMongoId('', { role: 'assistant' })).resolves.toBe(
        false
      );
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('updateToolCallStatusByToolCallId', () => {
    it('matches the owning row by JSONB containment and rewrites only the changed tool call', async () => {
      const repo = makeRepo({
        query: jest.fn(async () => [
          {
            id: '1',
            tool_calls: [
              { id: 'tc1', status: 'pending' },
              { id: 'tc2', status: 'success' },
            ],
          },
          // Carries no tc1, so it must not be rewritten.
          { id: '2', tool_calls: [{ id: 'tc2', status: 'success' }] },
        ]),
      });
      const service = makeService(repo);

      const affected = await service.updateToolCallStatusByToolCallId(
        CONVERSATION_ID,
        'tc1',
        'success'
      );

      expect(affected).toBe(1);
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [criteria, patch] = repo.update.mock.calls[0] as any[];
      expect(criteria).toEqual({ id: '1' });
      expect(patch.toolCalls).toEqual([
        { id: 'tc1', status: 'success' },
        { id: 'tc2', status: 'success' },
      ]);
    });

    it('scopes the containment query to the conversation with a needle array', async () => {
      const repo = makeRepo({ query: jest.fn(async () => []) });
      const service = makeService(repo);

      await service.updateToolCallStatusByToolCallId(CONVERSATION_ID, 'tc1', 'running');

      expect(repo.query).toHaveBeenCalledTimes(1);
      const [, params] = repo.query.mock.calls[0] as any[];
      expect(params).toEqual([CONVERSATION_ID, JSON.stringify([{ id: 'tc1' }])]);
    });

    it('does not write when the status already matches', async () => {
      const repo = makeRepo({
        query: jest.fn(async () => [
          { id: '1', tool_calls: [{ id: 'tc1', status: 'success' }] },
        ]),
      });
      const service = makeService(repo);

      const affected = await service.updateToolCallStatusByToolCallId(
        CONVERSATION_ID,
        'tc1',
        'success'
      );

      expect(affected).toBe(0);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('is a no-op when the store is unavailable', async () => {
      const service = makeUnavailableService();
      await expect(
        service.updateToolCallStatusByToolCallId(CONVERSATION_ID, 'tc1', 'success')
      ).resolves.toBe(0);
    });
  });
});
