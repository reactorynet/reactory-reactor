import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatsMacro } from './macro';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from 'mongodb';
import { ChatState, ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * A delegation that STALLS must never be reported as a completed result
 * (ticket REACTORY-302016408/20261006/2269478065).
 *
 * The original failure: the AUTO loop classified a tool as client-side, forwarded it
 * to a browser that a delegated session does not have, and paused. The runner then
 * returned the assistant's opening line ("I'll start by exploring the repo…") and the
 * delegation record said `complete`, so the caller proceeded as if the work was done.
 *
 * Two independent corrections are pinned here:
 *   1. `respond` and blocking `speakto` read the sub-agent transcript and report a
 *      stall as a non-complete status with an explicit error.
 *   2. The transcript helpers degrade to "healthy" when the log is missing, so a
 *      real result can never be downgraded by an unreadable file.
 */

const query = (doc: any): any => {
  const q: any = {
    lean: () => ({ exec: async () => doc }),
    exec: async () => doc,
  };
  q.then = (resolve: any) => resolve(doc);
  return q;
};

/** The real stall signature, captured from the ticket's session log. */
const STALLED_LOG = [
  '[2026-10-05T18:06:34.752Z] [DEBUG] Sending message {"personaId":"QualityQuinn","chatSessionId":"6ac3e72a52e025e43f3e8004","role":"user"}',
  '[2026-10-05T18:06:36.379Z] [INFO] [sendMessage] AUTO mode: executing 2 tool(s) server-side (iteration 1) {"tools":["readFile","readFile"]}',
  '[2026-10-05T18:06:36.379Z] [INFO] [sendMessage] AUTO mode: skipping client-side tool "readFile" — will be forwarded to client {"toolName":"readFile"}',
  '[2026-10-05T18:06:36.407Z] [INFO] [sendMessage] AUTO mode: pausing — client-side tool(s) pending. Server will resume when client reports results via ReactorCompleteClientToolCalls.',
].join('\n');

const HEALTHY_LOG = [
  '[2026-10-06T05:00:01.000Z] [INFO] [sendMessage] AUTO mode: executing 2 tool(s) server-side (iteration 1) {"tools":["readFile","grep"],"clientTools":[],"refusedTools":[]}',
  '[2026-10-06T05:00:03.000Z] [DEBUG] Response generated',
].join('\n');

describe('ChatsMacro - stalled delegations are not reported as results', () => {
  let chatState: ChatState;
  let dataRoot: string;
  let previousDataRoot: string | undefined;
  const mockSendMessage = jest.fn();

  const writeTranscript = (
    personaId: string,
    conversationId: string,
    text: string,
    userId: string,
  ): void => {
    const dir = path.join(dataRoot, 'profiles', userId, 'chats', personaId, conversationId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.log'), text);
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-stall-'));
    previousDataRoot = process.env.REACTORY_DATA;
    process.env.REACTORY_DATA = dataRoot;

    const mockContext: any = {
      user: { _id: new ObjectId(), firstName: 'Test', lastName: 'User', email: 'test@example.com' },
      getService: jest.fn((id: string) => {
        if (id.startsWith('reactor.AIPersonaProvider')) {
          return {
            listPersonas: jest.fn().mockResolvedValue([
              { id: 'daan', name: 'Docent Daan', modelId: 'gpt-4o', providerId: 'openai' },
            ]),
          };
        }
        if (id.startsWith('reactor.ReactorConversationService')) return { sendMessage: mockSendMessage };
        if (id.startsWith('reactor.ReactorProviderService')) {
          return {
            getProviders: jest.fn().mockResolvedValue([
              { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
            ]),
          };
        }
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

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.REACTORY_DATA;
    else process.env.REACTORY_DATA = previousDataRoot;
    try {
      (fs as any).rmSync(dataRoot, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  describe('respond', () => {
    const delegationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let subagentSessionId: string;

    beforeEach(() => {
      subagentSessionId = new ObjectId().toString();
    });

    const mockCompleteRecord = () => {
      jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation((filter: any) =>
        filter?._id === chatState.id
          ? query({
              _id: chatState.id,
              vars: {
                subagent_delegations: {
                  [delegationId]: {
                    status: 'complete',
                    personaId: 'daan',
                    agentName: 'Docent Daan',
                    subagentSessionId,
                    response: "I'll start by exploring the repo and reading the relevant files.",
                    completedAt: '2026-10-05T18:06:36.500Z',
                  },
                },
              },
            })
          : query(null),
      );
      jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockReturnValue({
        exec: async () => ({}),
      } as any);
    };

    it('reports a stalled turn as a non-complete status with an explicit error', async () => {
      mockCompleteRecord();
      writeTranscript('daan', subagentSessionId, STALLED_LOG, (chatState.context.user as any)._id.toString());

      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(false);
      expect(result.data.status).toBe('stalled');
      expect(result.data.stalled).toBe(true);
      expect(result.data.pendingClientToolCalls).toEqual(['readFile']);
      expect(result.error).toMatch(/DID NOT COMPLETE/);
      // The opening line is exposed only as partial output — never as `response`.
      expect(result.data.response).toBeUndefined();
      expect(result.data.partialResponse).toContain('I\'ll start by exploring');
      expect(result.instructions).toMatch(/NOT complete/i);
    });

    it('still returns the result when the transcript shows server-side tool execution', async () => {
      mockCompleteRecord();
      writeTranscript('daan', subagentSessionId, HEALTHY_LOG, (chatState.context.user as any)._id.toString());

      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.stalled).toBe(false);
      expect(result.data.response).toContain('I\'ll start by exploring');
    });

    it('treats a missing transcript as healthy rather than failing a real result', async () => {
      mockCompleteRecord();
      // No session.log written at all.
      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
    });
  });

  describe('speakto (blocking)', () => {
    it('fails loudly instead of returning the opening line when the turn stalled', async () => {
      const subagentSessionId = new ObjectId().toString();
      const openingLine = "I'll start by exploring the repo and reading the relevant files.";

      mockSendMessage.mockResolvedValue({ sessionId: subagentSessionId, content: openingLine });
      writeTranscript('daan', subagentSessionId, STALLED_LOG, (chatState.context.user as any)._id.toString());

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'read the repo' },
        chatState,
      );

      expect(result.success).toBe(false);
      expect(result.data.status).toBe('stalled');
      expect(result.data.stalled).toBe(true);
      expect(result.data.pendingClientToolCalls).toEqual(['readFile']);
      expect(result.data.partialResponse).toBe(openingLine);
      expect(result.error).toMatch(/DID NOT COMPLETE/);
    });

    it('returns the response normally when the sub-agent ran its tools server-side', async () => {
      const subagentSessionId = new ObjectId().toString();

      mockSendMessage.mockResolvedValue({ sessionId: subagentSessionId, content: 'Sub-agent answer' });
      writeTranscript('daan', subagentSessionId, HEALTHY_LOG, (chatState.context.user as any)._id.toString());

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'read the repo' },
        chatState,
      );

      expect(result.success).toBe(true);
      expect(result.data.response).toBe('Sub-agent answer');
      expect(result.data.conversationId).toBe(subagentSessionId);
      // The healthy/blocking payload shape is unchanged.
      expect(result.data.status).toBeUndefined();
    });
  });
});
