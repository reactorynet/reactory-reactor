import { GetUser, SearchUser, CreateUser } from "../macro";
import { createMockState } from "../../runtime/__tests__/support/mockState";

describe("User Macros", () => {
  let mockUserService: any;
  let mockContext: any;
  let mockState: any;

  beforeEach(() => {
    mockUserService = {
      findUserWithEmail: jest.fn(),
      searchUser: jest.fn(),
      search: jest.fn(),
      listAllUsers: jest.fn(),
      createUser: jest.fn(),
    };

    mockContext = {
      getService: jest.fn((serviceId: string) => {
        if (serviceId === "core.UserService@1.0.0") {
          return mockUserService;
        }
        return null;
      }),
      user: { _id: "user-admin", firstName: "Admin", lastName: "User", email: "admin@reactory.net" },
    };

    mockState = createMockState({
      context: mockContext,
      user: { id: "user-admin" },
      vars: {},
    });
  });

  describe("GetUser", () => {
    it("should return error if no email provided", async () => {
      const result = await GetUser({ email: "" }, mockState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No email provided");
    });

    it("should return found=false if user not found", async () => {
      mockUserService.findUserWithEmail.mockResolvedValue(null);

      const result = await GetUser({ email: "missing@example.com" }, mockState);
      expect(result.success).toBe(true);
      expect(result.data?.found).toBe(false);
      expect(result.data?.email).toBe("missing@example.com");
    });

    it("should find and return user by email", async () => {
      const mockUser = {
        id: "user-123",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane.doe@example.com",
      };

      mockUserService.findUserWithEmail.mockResolvedValue(mockUser);

      const result = await GetUser({ email: "jane.doe@example.com" }, mockState);
      expect(result.success).toBe(true);
      expect(result.data?.found).toBe(true);
      expect(result.data?.id).toBe("user-123");
      expect(result.data?.displayName).toBe("Jane Doe");
      // `vars` is persisted with the conversation, so it stores the projection too -
      // not the document (which carries password/salt/session material).
      expect(mockState.vars.lastGetUser.user).toEqual({
        id: "user-123",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane.doe@example.com",
        found: true,
        displayName: "Jane Doe",
      });
    });

    it("never persists a full user document in state.vars", async () => {
      const mockUser = {
        id: "user-9",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        password: "pbkdf2$10000$abcdef$0123456789abcdef",
        salt: "c0ffee-c0ffee-c0ffee",
        sessionInfo: [{ refresh: "refresh-token-value" }],
        authentications: [{ provider: "google", props: { accessToken: "ya29.secret" } }],
      };

      mockUserService.findUserWithEmail.mockResolvedValue(mockUser);

      const result = await GetUser({ email: "jane@example.com" }, mockState);
      const persisted = JSON.stringify(mockState.vars.lastGetUser);

      expect(persisted).not.toContain("pbkdf2$");
      expect(persisted).not.toContain("refresh-token-value");
      expect(persisted).not.toContain("ya29.secret");
      expect(mockState.vars.lastGetUser.user.sessionInfo).toBeUndefined();
      expect(result.data?.sessionInfo).toBeUndefined();
    });
  });

  describe("SearchUser", () => {
    it("should search users by query using searchUser service method", async () => {
      const mockUsers = [
        {
          _id: "user-1",
          firstName: "John",
          lastName: "Smith",
          email: "john.smith@example.com",
        },
        {
          _id: "user-2",
          firstName: "Johnny",
          lastName: "Depp",
          email: "johnny@example.com",
        },
      ];

      mockUserService.searchUser.mockResolvedValue(mockUsers);

      const result = await SearchUser({ query: "john", limit: 5 }, mockState);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data?.[0]).toEqual({
        id: "user-1",
        firstName: "John",
        lastName: "Smith",
        email: "john.smith@example.com",
        displayName: "John Smith",
      });
      expect(mockUserService.searchUser).toHaveBeenCalledWith("john", "email", 5);
      expect(mockState.vars.lastSearchUser).toEqual(result.data);
    });

    it("should return empty list when no users match", async () => {
      mockUserService.searchUser.mockResolvedValue([]);

      const result = await SearchUser({ query: "unknown-user" }, mockState);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect(result.instructions).toContain("No users found matching query");
    });
  });

  describe("CreateUser", () => {
    it("should return error if missing parameters", async () => {
      const result = await CreateUser({ email: "", firstName: "", lastName: "" }, mockState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No email provided");
    });

    it("should return existing user if user already exists", async () => {
      const mockExisting = {
        id: "user-existing",
        firstName: "Alice",
        lastName: "Walker",
        email: "alice@example.com",
      };
      mockUserService.findUserWithEmail.mockResolvedValue(mockExisting);

      const result = await CreateUser(
        { email: "alice@example.com", firstName: "Alice", lastName: "Walker" },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(false);
      expect(result.data?.id).toBe("user-existing");
    });

    it("should create new user successfully", async () => {
      mockUserService.findUserWithEmail.mockResolvedValue(null);
      const mockCreated = {
        id: "user-new",
        firstName: "Bob",
        lastName: "Builder",
        email: "bob@example.com",
      };
      mockUserService.createUser.mockResolvedValue(mockCreated);

      const result = await CreateUser(
        { email: "bob@example.com", firstName: "Bob", lastName: "Builder" },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(true);
      expect(result.data?.id).toBe("user-new");
      expect(mockUserService.createUser).toHaveBeenCalledWith({
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
      });
      expect(mockState.vars.lastCreateUser.created).toBe(true);
    });
  });
});

/**
 * `metadata.user` must be a string id, never a User document (acceptance criterion 3).
 *
 * Asserted against a *real macro return* with a document-bearing context, so a regression
 * that put `state.context.user` back into metadata fails here rather than passing on a
 * hand-built fixture.
 */
describe('User macros — metadata.user identity', () => {
  const userDocument = {
    _id: '5f1d7f000000000000000001',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    password: 'pbkdf2$10000$abcdef$0123456789abcdef',
    salt: 'c0ffee-c0ffee-c0ffee',
    sessionInfo: [{ refresh: 'refresh-token-value' }],
  };

  const buildState = () => {
    const userService = { findUserWithEmail: jest.fn().mockResolvedValue(userDocument) };

    return createMockState({
      user: { id: '5f1d7f000000000000000001' },
      context: {
        user: userDocument,
        getService: jest.fn((serviceId: string) =>
          serviceId === 'core.UserService@1.0.0' ? userService : null
        ),
      },
      vars: {},
    });
  };

  it('getUser reports the acting user id as metadata.user, not the document', async () => {
    const result = await GetUser({ email: 'ada@example.com' }, buildState());

    expect(result.success).toBe(true);
    expect(typeof result.metadata?.user).toBe('string');
    expect(result.metadata?.user).toBe('5f1d7f000000000000000001');

    // The metadata payload carries no credential material either.
    const serialised = JSON.stringify(result.metadata);
    expect(serialised).not.toContain('pbkdf2');
    expect(serialised).not.toContain('refresh-token-value');
  });
});