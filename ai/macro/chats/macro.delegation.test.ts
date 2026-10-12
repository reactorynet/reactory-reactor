import { ChatsMacro } from './macro';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from 'mongodb';
import { ChatState, ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * Delegation lifecycle integrity (ticket …/849851804).
 *
 * Background: the parent turn's `executeMacro` used to `$set` the WHOLE `vars` object from
 * a pre-tool snapshot, which wiped the async delegation record written out-of-band by
 * `speakto`. The background runner then recreated the record from only its leaf `$set`s,
 * leaving `{status, response, completedAt}` and losing `personaId`/`agentName`/
 * `subagentSessionId`. `followup` by delegationId then had nothing to resolve.
 *
 * These tests pin the two halves of the fix:
 *   - completion/error write the WHOLE record (self-healing regardless of the parent), and
 *   - the delegationId is stamped on the sub-agent session, so it can always be resolved.
 */

/** A mongoose-like query: awaitable AND `.lean().exec()`-able. */
const query = (doc: any): any => {
  const q: any = {
    lean: () => ({ exec: async () => doc }),
    exec: async () => doc,
  };
  q.then = (resolve: any) => resolve(doc);
  return q;
};

describe('ChatsMacro - delegation lifecycle', () => {
  let chatState: ChatState;
  const mockSendMessage = jest.fn();
  const mockListPersonas = jest.fn();
  const mockGetProviders = jest.fn();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    mockListPersonas.mockResolvedValue([
      { id: 'daan', name: 'Docent Daan', modelId: 'gpt-4o', providerId: 'openai' },
    ]);
    mockGetProviders.mockResolvedValue([
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
    ]);

    const mockContext: any = {
      user: { _id: new ObjectId(), firstName: 'Test', lastName: 'User', email: 'test@example.com' },
      getService: jest.fn((id: string) => {
        if (id.startsWith('reactor.AIPersonaProvider')) return { listPersonas: mockListPersonas };
        if (id.startsWith('reactor.ReactorConversationService')) return { sendMessage: mockSendMessage };
        if (id.startsWith('reactor.ReactorProviderService')) return { getProviders: mockGetProviders };
        return null;
      }),
      hasAnyRole: jest.fn().mockReturnValue(true),
      hasRole: jest.fn().mockReturnValue(true),
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };

    chatState = {
      id: new ObjectId().toString(),
      personaId: 'ReactorAIPersona',
      modelId: 'gpt-4o',
      providerId: 'openai',
      toolApprovalMode: ToolApprovalMode.AUTO,
      history: [],
      vars: {},
      context: mockContext,
    } as any;
  });

  describe('async dispatch', () => {
    it('stamps the delegationId on the sub-agent session and records the full dispatch record', async () => {
      const createSpy = jest.spyOn(ReactorConversationModel, 'create').mockResolvedValue({} as any);
      const updates: any[] = [];
      jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockImplementation((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: async () => ({}) } as any;
      });

      // Never resolves — we only assert the dispatch side.
      mockSendMessage.mockImplementation(() => new Promise(() => {}));

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'do work', async: true, wakeParent: false },
        chatState,
      );

      const delegationId = result.data.delegationId;
      const subagentSessionId = result.data.subagentSessionId;

      // Durable mapping: the sub-agent session carries the delegationId.
      expect(createSpy).toHaveBeenCalledTimes(1);
      const created = createSpy.mock.calls[0][0] as any;
      expect(created.vars).toEqual({ delegationId });
      expect(created._id).toBe(subagentSessionId);
      expect(created.parentSessionId).toBe(chatState.id);

      // Full dispatch record (not leaf fields).
      const record = updates
        .map((u) => u.update?.$set?.[`vars.subagent_delegations.${delegationId}`])
        .find(Boolean);
      expect(record).toBeDefined();
      expect(record.status).toBe('dispatched');
      expect(record.personaId).toBe('daan');
      expect(record.agentName).toBe('Docent Daan');
      expect(record.subagentSessionId).toBe(subagentSessionId);
      expect(record.parentSessionId).toBe(chatState.id);
      expect(record.message).toBe('do work');
      expect(record.startedAt).toBeDefined();
    });
  });

  describe('async completion', () => {
    it('writes the WHOLE delegation record, preserving the identifying fields', async () => {
      jest.spyOn(ReactorConversationModel, 'create').mockResolvedValue({} as any);
      const updates: any[] = [];
      jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockImplementation((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: async () => ({}) } as any;
      });

      let resolveWork: (v: any) => void = () => {};
      mockSendMessage.mockImplementation(() => new Promise((resolve) => { resolveWork = resolve; }));

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'do work', async: true, wakeParent: false },
        chatState,
      );
      const delegationId = result.data.delegationId;
      const subagentSessionId = result.data.subagentSessionId;

      resolveWork({ content: 'the result' });
      // Flush the fire-and-forget runner.
      await new Promise((r) => setImmediate(r));

      const record = updates
        .map((u) => u.update?.$set?.[`vars.subagent_delegations.${delegationId}`])
        .find((r: any) => r?.status === 'complete');

      expect(record).toBeDefined();
      // The fields that USED to be lost:
      expect(record.personaId).toBe('daan');
      expect(record.agentName).toBe('Docent Daan');
      expect(record.subagentSessionId).toBe(subagentSessionId);
      expect(record.parentSessionId).toBe(chatState.id);
      expect(record.message).toBe('do work');
      expect(record.startedAt).toBeDefined();
      // ...alongside the completion fields:
      expect(record.response).toBe('the result');
      expect(record.completedAt).toBeDefined();

      // And it was written as ONE whole-record $set — never as `...status` leaves.
      const update = updates.find((u) => u.update?.$set?.[`vars.subagent_delegations.${delegationId}`]?.status === 'complete');
      const leafKeys = Object.keys(update.update.$set).filter((k) => k.startsWith(`vars.subagent_delegations.${delegationId}.`));
      expect(leafKeys).toEqual([]);
    });

    it('writes the whole record on failure too, so an errored delegation stays resolvable', async () => {
      jest.spyOn(ReactorConversationModel, 'create').mockResolvedValue({} as any);
      const updates: any[] = [];
      jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockImplementation((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: async () => ({}) } as any;
      });

      let rejectWork: (e: any) => void = () => {};
      mockSendMessage.mockImplementation(() => new Promise((_res, rej) => { rejectWork = rej; }));

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'do work', async: true, wakeParent: false },
        chatState,
      );
      const delegationId = result.data.delegationId;

      rejectWork(new Error('provider exploded'));
      await new Promise((r) => setImmediate(r));

      const record = updates
        .map((u) => u.update?.$set?.[`vars.subagent_delegations.${delegationId}`])
        .find((r: any) => r?.status === 'error');

      expect(record).toBeDefined();
      expect(record.subagentSessionId).toBe(result.data.subagentSessionId);
      expect(record.personaId).toBe('daan');
      expect(record.error).toContain('provider exploded');
    });
  });

  describe('followup by delegationId', () => {
    const delegationId = '11111111-2222-3333-4444-555555555555';
    let subagentSessionId: string;

    beforeEach(() => {
      subagentSessionId = new ObjectId().toString();
    });

    it('resolves via the parent delegation record', async () => {
      jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation((filter: any) => {
        if (filter?._id === chatState.id) {
          return query({
            _id: chatState.id,
            vars: {
              subagent_delegations: {
                [delegationId]: { status: 'complete', subagentSessionId, personaId: 'daan', agentName: 'Docent Daan' },
              },
            },
          });
        }
        if (filter?._id === subagentSessionId) {
          return query({
            _id: subagentSessionId,
            personaId: 'daan',
            history: [
              { role: 'user', content: 'do work' },
              { role: 'assistant', content: 'the answer' },
            ],
          });
        }
        return query(null);
      });

      const result: any = await ChatsMacro({ action: 'followup', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.conversationId).toBe(subagentSessionId);
      expect(result.data.personaId).toBe('daan');
      expect(result.data.messageCount).toBe(2);
    });

    it('falls back to the delegationId stamped on the sub-agent session when the parent record is gone', async () => {
      jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation((filter: any) => {
        // Parent has NO delegation record — the exact post-clobber state.
        if (filter?._id === chatState.id) return query({ _id: chatState.id, vars: {} });
        // Durable stamp lookup.
        if (filter?.['vars.delegationId'] === delegationId) return query({ _id: subagentSessionId });
        if (filter?._id === subagentSessionId) {
          return query({ _id: subagentSessionId, personaId: 'daan', history: [{ role: 'assistant', content: 'answer' }] });
        }
        return query(null);
      });

      const result: any = await ChatsMacro({ action: 'followup', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.conversationId).toBe(subagentSessionId);
      expect(result.data.personaId).toBe('daan');
    });

    it('returns a clear not-found instead of throwing when a delegationId cannot be resolved', async () => {
      jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation(() => query(null));

      const result: any = await ChatsMacro({ action: 'followup', id: delegationId }, chatState);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not resolve');
    });
  });

  describe('respond metadata', () => {
    it('returns the real subagentSessionId (never the delegationId) and the agent name', async () => {
      const delegationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const subagentSessionId = new ObjectId().toString();

      jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation((filter: any) => {
        if (filter?._id === chatState.id) {
          return query({
            _id: chatState.id,
            vars: {
              subagent_delegations: {
                [delegationId]: {
                  status: 'complete',
                  personaId: 'daan',
                  agentName: 'Docent Daan',
                  subagentSessionId,
                  response: 'the delivered result',
                  completedAt: '2026-10-12T09:00:00.000Z',
                },
              },
            },
          });
        }
        return query(null);
      });
      jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockReturnValue({
        exec: async () => ({}),
      } as any);

      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.personaId).toBe('daan');
      expect(result.data.subagentSessionId).toBe(subagentSessionId);
      expect(result.data.subagentSessionId).not.toBe(delegationId);
      expect(result.data.response).toBe('the delivered result');
    });
  });
});
