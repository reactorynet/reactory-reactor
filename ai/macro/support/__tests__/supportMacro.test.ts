import {
  GetSupportTicket,
  ListSupportTickets,
  CreateSupportTicket,
  UpdateSupportTicket,
  AddSupportTicketComment,
} from "../macro";
import { createMockState } from "../../runtime/__tests__/support/mockState";

describe("Support Ticket Macros", () => {
  let mockSupportService: any;
  let mockContext: any;
  let mockState: any;

  beforeEach(() => {
    mockSupportService = {
      getTicket: jest.fn(),
      pagedRequest: jest.fn(),
      createRequest: jest.fn(),
      updateTicket: jest.fn(),
      addComment: jest.fn(),
    };

    mockContext = {
      getService: jest.fn((serviceId: string) => {
        if (serviceId === "core.ReactorySupportService@1.0.0") {
          return mockSupportService;
        }
        return null;
      }),
      user: { _id: "user-123", firstName: "Test", lastName: "User", email: "test@reactory.net" },
    };

    mockState = createMockState({
      context: mockContext,
      user: { id: "user-123" },
      vars: {},
    });
  });

  describe("GetSupportTicket", () => {
    it("should return error if no id provided", async () => {
      const result = await GetSupportTicket({ id: "" }, mockState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No ticket ID provided");
    });

    it("should retrieve a ticket successfully", async () => {
      const mockTicket = {
        id: "ticket-1",
        reference: "REF-001",
        request: "Login issue",
        status: "open",
        priority: "high",
        requestType: "bug",
        description: "Cannot login with Google auth",
        createdBy: { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
        assignedTo: null,
      };

      mockSupportService.getTicket.mockResolvedValue(mockTicket);

      const result = await GetSupportTicket({ id: "ticket-1" }, mockState);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTicket);
      expect(mockSupportService.getTicket).toHaveBeenCalledWith("ticket-1");
      expect(mockState.vars.lastSupportTicket).toEqual(mockTicket);
    });
  });

  describe("ListSupportTickets", () => {
    it("should list tickets with filters and pagination", async () => {
      const mockPagedResult = {
        paging: { page: 1, pageSize: 10, total: 1, hasNext: false },
        tickets: [
          {
            id: "ticket-1",
            reference: "REF-001",
            request: "Survey round stalled",
            status: "open",
            priority: "critical",
            assignedTo: { firstName: "Susan", lastName: "Support" },
          },
        ],
      };

      mockSupportService.pagedRequest.mockResolvedValue(mockPagedResult);

      const result = await ListSupportTickets(
        { status: ["open"], priority: ["critical"], page: 1, pageSize: 10 },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPagedResult);
      expect(mockSupportService.pagedRequest).toHaveBeenCalledWith(
        expect.objectContaining({ status: ["open"], priority: ["critical"] }),
        { page: 1, pageSize: 10 }
      );
    });
  });

  describe("CreateSupportTicket", () => {
    it("should validate required fields", async () => {
      const result = await CreateSupportTicket({ request: "", description: "" }, mockState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No request summary provided");
    });

    it("should create a support ticket successfully", async () => {
      const mockCreatedTicket = {
        id: "ticket-new-1",
        reference: "REF-NEW-1",
        request: "Add missing user to round",
        description: "Please add participant to feedback round 3",
        status: "new",
        priority: "high",
        requestType: "round_support",
      };

      mockSupportService.createRequest.mockResolvedValue(mockCreatedTicket);

      const result = await CreateSupportTicket(
        {
          request: "Add missing user to round",
          description: "Please add participant to feedback round 3",
          priority: "high",
          requestType: "round_support",
        },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockCreatedTicket);
      expect(mockSupportService.createRequest).toHaveBeenCalledWith(
        "Add missing user to round",
        "Please add participant to feedback round 3",
        "round_support",
        { priority: "high" },
        undefined
      );
      expect(mockState.vars.lastCreatedSupportTicket).toEqual(mockCreatedTicket);
    });
  });

  describe("UpdateSupportTicket", () => {
    it("should update a ticket status and assignment", async () => {
      const mockUpdatedTicket = {
        id: "ticket-1",
        status: "in_progress",
        priority: "high",
        assignedTo: { firstName: "Ivy", lastName: "Infrastructure" },
      };

      mockSupportService.updateTicket.mockResolvedValue(mockUpdatedTicket);

      const result = await UpdateSupportTicket(
        {
          ticketId: "ticket-1",
          status: "in_progress",
          assignTo: "ivy-user-id",
          comment: "Assigned to Infrastructure Ivy for server investigation",
        },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockUpdatedTicket);
      expect(mockSupportService.updateTicket).toHaveBeenCalledWith(
        "ticket-1",
        expect.objectContaining({
          status: "in_progress",
          assignTo: "ivy-user-id",
          comment: "Assigned to Infrastructure Ivy for server investigation",
        })
      );
      expect(mockState.vars.lastUpdatedSupportTicket).toEqual(mockUpdatedTicket);
    });
  });

  describe("AddSupportTicketComment", () => {
    it("should add a comment to a ticket", async () => {
      const mockComment = {
        id: "comment-1",
        text: "Checked telemetry logs, database connection spike identified.",
        createdAt: new Date(),
      };

      mockSupportService.addComment.mockResolvedValue(mockComment);

      const result = await AddSupportTicketComment(
        {
          ticketId: "ticket-1",
          comment: "Checked telemetry logs, database connection spike identified.",
        },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockComment);
      expect(mockSupportService.addComment).toHaveBeenCalledWith(
        "ticket-1",
        "Checked telemetry logs, database connection spike identified.",
        undefined,
        undefined
      );
      expect(mockState.vars.lastSupportTicketComment).toEqual(mockComment);
    });
  });
});
