import { ChatsMacro } from './macro';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from 'mongodb';

/**
 * Data isolation for the `chats` tool (review finding F2).
 *
 * The macro used to pass `state.context.user` - a full User document - into query
 * filters and `ReactorConversationModel.create()`. It now passes the acting user's id.
 * The failure mode this suite pins is the one that made the change dangerous:
 * `actorUserId()` returning `undefined`, because Mongoose **drops** an undefined
 * predicate when casting, so `find({ user: undefined })` matches every conversation
 * rather than failing. A missing user must therefore fail closed.
 */

const thenable = (value: any) => ({ then: (resolve: any) => Promise.resolve(value).then(resolve) });

describe('ChatsMacro — acting user', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails closed and queries nothing when no acting user id can be resolved', async () => {
    const findSpy = jest.spyOn(ReactorConversationModel, 'find');

    const state: any = {
      id: new ObjectId().toString(),
      personaId: 'ReactorAIPersona',
      history: [],
      vars: {},
      // No state.user and no context.user: nothing to scope the query by.
      context: {
        getService: jest.fn(() => null),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };

    const result: any = await ChatsMacro({ action: 'list' }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No acting user');
    // The decisive assertion: an unscoped find() would have read every user's chats.
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('queries by the acting user id string, never by the User document', async () => {
    const userId = new ObjectId();
    const findSpy = jest
      .spyOn(ReactorConversationModel, 'find')
      .mockReturnValue(thenable([]) as any);

    const state: any = {
      id: new ObjectId().toString(),
      personaId: 'ReactorAIPersona',
      history: [],
      vars: {},
      // A document-bearing context is the interesting case: it carries the PBKDF2 hash
      // and session material, and used to be handed to Mongoose whole.
      context: {
        user: {
          _id: userId,
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          password: 'pbkdf2$10000$abcdef$0123456789abcdef',
          salt: 'c0ffee-c0ffee-c0ffee',
          sessionInfo: [{ refresh: 'refresh-token-value' }],
        },
        getService: jest.fn(() => null),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };

    const result: any = await ChatsMacro({ action: 'list' }, state);

    expect(result.success).toBe(true);
    expect(findSpy).toHaveBeenCalledTimes(1);

    const filter: any = (findSpy.mock.calls as any[])[0][0];
    expect(typeof filter.user).toBe('string');
    expect(filter.user).toBe(userId.toString());
  });
});
