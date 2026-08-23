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
      expect(mockState.vars.lastGetUser.user).toEqual(mockUser);
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
