import {
  GetSupportTicket,
  ListSupportTickets,
  CreateSupportTicket,
  UpdateSupportTicket,
  AddSupportTicketComment,
} from '../macro';
import { createMockState } from '../../runtime/__tests__/support/mockState';

/**
 * Credential hygiene for the support macros.
 *
 * The defect: every macro returned the service result as `data`, and the service
 * populated the ticket's user references without a field selection. Tool results are
 * appended to the conversation and sent to the model provider, so one `getSupportTicket`
 * call disclosed, for every person on the ticket:
 *
 *   - `password` (PBKDF2 hash) and `salt`
 *   - `sessionInfo[].jwtPayload` / `jwtPayloadJson` and the `refresh` token
 *   - `authentications[].props.accessToken` (third-party OAuth tokens)
 *   - `memberships`, `roles`, socials
 *
 * `state.vars` is persisted with the conversation, so storing the document there leaked
 * it again on every subsequent turn.
 */

const CREDENTIAL_VALUES = [
  'pbkdf2$10000$abcdef$0123456789abcdef',
  'c0ffee-c0ffee-c0ffee',
  'refresh-token-value',
  'ya29.secret-access-token',
  'header.payload.signature',
];

/** A populated User document in the shape the service actually returned. */
const userDocument = (overrides: Record<string, any> = {}) => ({
  _id: '5f1d7f000000000000000001',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  username: 'ada',
  password: 'pbkdf2$10000$abcdef$0123456789abcdef',
  salt: 'c0ffee-c0ffee-c0ffee',
  memberships: [{ roles: ['ADMIN'] }],
  roles: ['ADMIN'],
  sessionInfo: [
    {
      jwtToken: 'header.payload.signature',
      jwtPayload: { sub: '5f1d7f000000000000000001' },
      jwtPayloadJson: '{"sub":"5f1d7f000000000000000001"}',
      refresh: 'refresh-token-value',
      refreshToken: 'refresh-token-value',
    },
  ],
  authentications: [
    { provider: 'google', props: { accessToken: 'ya29.secret-access-token' } },
  ],
  ...overrides,
});

const expectNoCredentials = (value: any) => {
  const serialised = JSON.stringify(value);
  for (const secret of CREDENTIAL_VALUES) {
    expect(serialised).not.toContain(secret);
  }
  expect(serialised).not.toContain('pbkdf2$');
  expect(serialised).not.toContain('sessionInfo');
  expect(serialised).not.toContain('authentications');
};

const ticketWithPeople = () => ({
  id: '507f1f77bcf86cd799439011',
  reference: 'ACME-1A2B/20260101/9F8E',
  request: 'Login issue',
  description: 'Cannot login with Google auth',
  status: 'open',
  priority: 'high',
  requestType: 'bug',
  tags: ['auth'],
  createdBy: userDocument(),
  reportedBy: userDocument({ _id: '5f1d7f000000000000000002' }),
  updatedBy: userDocument({ _id: '5f1d7f000000000000000003' }),
  assignedTo: userDocument({ _id: '5f1d7f000000000000000004', firstName: 'Ivy' }),
  comments: [
    {
      id: 'comment-1',
      text: 'Looking into it',
      createdAt: new Date('2026-01-01T08:00:00.000Z'),
      user: userDocument({ _id: '5f1d7f000000000000000005' }),
    },
  ],
  documents: [
    {
      id: 'file-1',
      filename: 'logs.txt',
      alias: 'logs',
      url: 'https://files.example.com/logs.txt',
      size: 42,
      mimetype: 'text/plain',
    },
  ],
});

describe('Support macros — credential hygiene', () => {
  let mockSupportService: any;
  let mockState: any;

  beforeEach(() => {
    mockSupportService = {
      getTicket: jest.fn(),
      pagedRequest: jest.fn(),
      createRequest: jest.fn(),
      updateTicket: jest.fn(),
      addComment: jest.fn(),
    };

    mockState = createMockState({
      context: {
        getService: jest.fn((serviceId: string) =>
          serviceId === 'core.ReactorySupportService@1.0.0' ? mockSupportService : null
        ),
        user: { _id: 'user-123' },
      },
      user: { id: 'user-123' },
      vars: {},
    });
  });

  it('getSupportTicket returns projected people, never the User documents', async () => {
    mockSupportService.getTicket.mockResolvedValue(ticketWithPeople());

    const result = await GetSupportTicket({ id: '507f1f77bcf86cd799439011' }, mockState);

    expect(result.success).toBe(true);
    expectNoCredentials(result.data);
    expectNoCredentials(result.instructions);
    expectNoCredentials(mockState.vars);

    const view: any = result.data;
    expect(view.createdBy).toEqual({
      id: '5f1d7f000000000000000001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });
    expect(view.assignedTo.displayName).toBe('Ivy Lovelace');
    expect(view.comments[0].author).toEqual({
      id: '5f1d7f000000000000000005',
      name: 'Ada Lovelace',
    });
    expect(view.documents[0]).toEqual(
      expect.objectContaining({ id: 'file-1', filename: 'logs.txt' })
    );
  });

  it('listSupportTickets projects every row and keeps the paging envelope', async () => {
    mockSupportService.pagedRequest.mockResolvedValue({
      paging: { page: 1, pageSize: 10, total: 1, hasNext: false },
      tickets: [ticketWithPeople()],
    });

    const result = await ListSupportTickets({ page: 1, pageSize: 10 }, mockState);

    expect(result.success).toBe(true);
    expect(result.data.paging).toEqual({ page: 1, pageSize: 10, total: 1, hasNext: false });
    expect(result.data.tickets).toHaveLength(1);
    expectNoCredentials(result.data);
    expectNoCredentials(mockState.vars);
  });

  it('createSupportTicket projects the created ticket into data and vars', async () => {
    mockSupportService.createRequest.mockResolvedValue(ticketWithPeople());

    const result = await CreateSupportTicket(
      { request: 'Login issue', description: 'Cannot login' },
      mockState
    );

    expect(result.success).toBe(true);
    expectNoCredentials(result.data);
    expectNoCredentials(mockState.vars.lastCreatedSupportTicket);
    expect((result.data as any).createdBy.displayName).toBe('Ada Lovelace');
  });

  it('updateSupportTicket projects the updated ticket into data and vars', async () => {
    mockSupportService.updateTicket.mockResolvedValue(ticketWithPeople());

    const result = await UpdateSupportTicket(
      { ticketId: '507f1f77bcf86cd799439011', status: 'in_progress' },
      mockState
    );

    expect(result.success).toBe(true);
    expectNoCredentials(result.data);
    expectNoCredentials(mockState.vars.lastUpdatedSupportTicket);
    expect((result.data as any).assignedTo.displayName).toBe('Ivy Lovelace');
  });

  it('addSupportTicketComment projects a comment whose user is a full document', async () => {
    mockSupportService.addComment.mockResolvedValue({
      id: 'comment-9',
      text: 'Checked telemetry logs',
      createdAt: new Date('2026-01-02T08:00:00.000Z'),
      user: userDocument(),
    });

    const result = await AddSupportTicketComment(
      { ticketId: '507f1f77bcf86cd799439011', comment: 'Checked telemetry logs' },
      mockState
    );

    expect(result.success).toBe(true);
    expectNoCredentials(result.data);
    expectNoCredentials(mockState.vars.lastSupportTicketComment);
    expect((result.data as any).author.name).toBe('Ada Lovelace');
  });

  it('keeps an unpopulated reference identifiable by id without inventing a name', async () => {
    mockSupportService.getTicket.mockResolvedValue({
      id: '507f1f77bcf86cd799439011',
      request: 'Login issue',
      status: 'open',
      createdBy: '5f1d7f000000000000000001',
      assignedTo: null,
    });

    const result = await GetSupportTicket({ id: '507f1f77bcf86cd799439011' }, mockState);

    expect((result.data as any).createdBy).toEqual({
      id: '5f1d7f000000000000000001',
      firstName: null,
      lastName: null,
      email: null,
      displayName: null,
    });
    expect((result.data as any).assignedTo).toBeNull();
  });
});

/**
 * `metadata.user` must be a string id, never a User document (acceptance criterion 3).
 *
 * Asserted against the real macro returns with a document-bearing `context.user`, so a
 * regression to `state.context.user` in the metadata block fails here.
 */
describe('Support macros — metadata.user identity', () => {
  const userDocument = {
    _id: '5f1d7f000000000000000001',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    password: 'pbkdf2$10000$abcdef$0123456789abcdef',
    salt: 'c0ffee-c0ffee-c0ffee',
    sessionInfo: [{ refresh: 'refresh-token-value' }],
  };

  const ticket = (): any => ({
    id: '507f1f77bcf86cd799439011',
    reference: 'ACME-1A2B/20260101/9F8E',
    request: 'Login issue',
    status: 'open',
    priority: 'high',
    createdBy: userDocument,
    assignedTo: null,
  });

  const buildState = (service: any) =>
    createMockState({
      user: { id: '5f1d7f000000000000000001' },
      context: {
        user: userDocument,
        getService: jest.fn((serviceId: string) =>
          serviceId === 'core.ReactorySupportService@1.0.0' ? service : null
        ),
      },
      vars: {},
    });

  it('getSupportTicket reports a string metadata.user', async () => {
    const service = { getTicket: jest.fn().mockResolvedValue(ticket()) };
    const result = await GetSupportTicket(
      { id: '507f1f77bcf86cd799439011' },
      buildState(service)
    );

    expect(result.success).toBe(true);
    expect(typeof result.metadata?.user).toBe('string');
    expect(result.metadata?.user).toBe('5f1d7f000000000000000001');
    expect(JSON.stringify(result.metadata)).not.toContain('pbkdf2');
  });

  it('listSupportTickets reports a string metadata.user', async () => {
    const service = {
      pagedRequest: jest.fn().mockResolvedValue({
        paging: { page: 1, pageSize: 10, total: 1, hasNext: false },
        tickets: [ticket()],
      }),
    };

    const result = await ListSupportTickets({ page: 1, pageSize: 10 }, buildState(service));

    expect(result.success).toBe(true);
    expect(typeof result.metadata?.user).toBe('string');
    expect(result.metadata?.user).toBe('5f1d7f000000000000000001');
    expect(JSON.stringify(result.metadata)).not.toContain('pbkdf2');
  });
});