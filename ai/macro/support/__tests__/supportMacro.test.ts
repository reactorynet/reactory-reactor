import {
  GetSupportTicket,
  ListSupportTickets,
  CreateSupportTicket,
  UpdateSupportTicket,
  AddSupportTicketComment,
  GetSupportTicketComments,
  GetSupportTicketAttachments,
  AttachSupportTicketFile,
  GetSupportTicketCommentsRegistry,
  GetSupportTicketAttachmentsRegistry,
  AttachSupportTicketFileRegistry,
  MAX_ATTACHMENT_BYTES,
} from "../macro";
import SupportMacros from "../index";
import { MacroRegistry, getMacro } from "../../index";
import { createMockState } from "../../runtime/__tests__/support/mockState";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("Support Ticket Macros", () => {
  let mockSupportService: any;
  let mockFileService: any;
  let mockContext: any;
  let mockState: any;

  beforeEach(() => {
    mockSupportService = {
      getTicket: jest.fn(),
      pagedRequest: jest.fn(),
      createRequest: jest.fn(),
      updateTicket: jest.fn(),
      addComment: jest.fn(),
      getTicketComments: jest.fn(),
      listTicketDocuments: jest.fn(),
      attachDocument: jest.fn(),
    };

    mockFileService = {
      uploadFile: jest.fn(),
    };

    mockContext = {
      getService: jest.fn((serviceId: string) => {
        if (serviceId === "core.ReactorySupportService@1.0.0") {
          return mockSupportService;
        }
        if (serviceId === "core.ReactoryFileService@1.0.0") {
          return mockFileService;
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
    const OBJECT_ID = "507f1f77bcf86cd799439011";

    it("should return error if no id provided", async () => {
      const result = await GetSupportTicket({ id: "" }, mockState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No ticket ID provided");
    });

    it("should retrieve a ticket by ObjectId successfully", async () => {
      const mockTicket: any = {
        id: OBJECT_ID,
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

      const result = await GetSupportTicket({ id: OBJECT_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTicket);
      expect(mockSupportService.getTicket).toHaveBeenCalledWith(OBJECT_ID);
      expect(mockSupportService.pagedRequest).not.toHaveBeenCalled();
      expect(mockState.vars.lastSupportTicket).toEqual(mockTicket);
    });

    it("should fall back to a reference lookup when the id is not an ObjectId", async () => {
      const reference = "ACME-1A2B/20260101/9F8E";
      const mockTicket: any = {
        id: OBJECT_ID,
        reference,
        request: "Login issue",
        status: "open",
        priority: "high",
        requestType: "bug",
        description: "Cannot login with Google auth",
        createdBy: { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
        assignedTo: null,
      };

      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 1, hasNext: false },
        tickets: [mockTicket],
      });

      const result = await GetSupportTicket({ id: reference.toLowerCase() }, mockState);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTicket);
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
      // The reference is queried in both its raw and upper-cased form.
      expect(mockSupportService.pagedRequest).toHaveBeenCalledWith(
        { reference: [reference.toLowerCase(), reference] },
        { page: 1, pageSize: 1 }
      );
      expect(mockState.vars.lastSupportTicket).toEqual(mockTicket);
    });

    it("should report not found when a reference does not resolve", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 0, hasNext: false },
        tickets: [],
      });

      const result = await GetSupportTicket({ id: "NO-SUCH-REF" }, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("reference NO-SUCH-REF");
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
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

  /* ----------------------------------------------------------------------- *
   * TOOLS-002 — reading the ticket conversation and attachments, and
   * attaching a file.
   * ----------------------------------------------------------------------- */

  const TICKET_ID = "507f1f77bcf86cd799439011";
  const FILE_ID = "507f1f77bcf86cd799439012";
  const UPLOADED_FILE_ID = "507f1f77bcf86cd799439099";
  const REFERENCE = "ACME-1A2B/20260101/9F8E";

  const ticketDoc = (overrides: Record<string, unknown> = {}) => ({
    id: TICKET_ID,
    reference: REFERENCE,
    request: "Login issue",
    status: "open",
    priority: "high",
    ...overrides,
  });

  const fileView = (overrides: Record<string, unknown> = {}) => ({
    id: FILE_ID,
    filename: "screenshot.png",
    alias: "Screenshot",
    url: "/files/screenshot.png",
    size: 2048,
    mimetype: "image/png",
    ...overrides,
  });

  /** A state whose context cannot resolve any service at all. */
  const stateWithoutSupportService = () =>
    createMockState({
      context: { getService: jest.fn(() => null) } as any,
      user: { id: "user-123" },
      vars: {},
    });

  const expectFailureEnvelope = (result: any, tool: string, params: unknown) => {
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.tool).toBe(tool);
    expect(result.params).toEqual(params);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        executionTime: expect.any(Number),
        timestamp: expect.any(Date),
        user: "user-123",
      })
    );
  };

  describe("TOOLS-002 registry wiring", () => {
    it("registers every new macro and exposes it by tool name", () => {
      expect(SupportMacros.map((macro) => macro.name)).toEqual(
        expect.arrayContaining([
          "getSupportTicketComments",
          "getSupportTicketAttachments",
          "attachSupportTicketFile",
        ])
      );

      const toolNames = MacroRegistry.flatMap((macro) =>
        (macro.tools || []).map((tool: any) => tool?.function?.name)
      );
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "getSupportTicketComments",
          "getSupportTicketAttachments",
          "attachSupportTicketFile",
        ])
      );

      expect(getMacro("getSupportTicketComments")).toBe(GetSupportTicketComments);
      expect(getMacro("getSupportTicketAttachments")).toBe(GetSupportTicketAttachments);
      expect(getMacro("attachSupportTicketFile")).toBe(AttachSupportTicketFile);
      expect(GetSupportTicketCommentsRegistry.component).toBe(GetSupportTicketComments);
      expect(GetSupportTicketAttachmentsRegistry.component).toBe(GetSupportTicketAttachments);
      expect(AttachSupportTicketFileRegistry.component).toBe(AttachSupportTicketFile);
    });
  });

  describe("GetSupportTicketComments", () => {
    it("returns the thread oldest first with author names and parentId", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        {
          id: "comment-3",
          text: "Closing the loop.",
          createdAt: new Date("2026-01-03T10:00:00.000Z"),
          author: { id: "user-3", name: "Cara Close" },
          parentId: null,
          attachments: [],
        },
        {
          id: "comment-1",
          text: "Reproduced on staging.",
          createdAt: new Date("2026-01-01T08:00:00.000Z"),
          author: { id: "user-1", name: "Alice Smith" },
          parentId: null,
          attachments: [fileView()],
        },
        {
          id: "comment-2",
          text: "Thanks — deploying the fix.",
          createdAt: new Date("2026-01-02T09:30:00.000Z"),
          author: { id: "user-2", name: "Bob Builder" },
          parentId: "comment-1",
          attachments: [],
        },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(mockSupportService.getTicketComments).toHaveBeenCalledWith(TICKET_ID);
      expect(result.data.comments.map((comment: any) => comment.id)).toEqual([
        "comment-1",
        "comment-2",
        "comment-3",
      ]);
      expect(result.data.comments[0].author).toEqual({ id: "user-1", name: "Alice Smith" });
      expect(result.data.comments[0].createdAt).toEqual(new Date("2026-01-01T08:00:00.000Z"));
      expect(result.data.comments[1].parentId).toBe("comment-1");
      expect(result.data.comments[1].author.name).toBe("Bob Builder");
      expect(result.data.comments[2].parentId).toBeNull();
      expect(result.data.comments[0].attachments[0]).toEqual(fileView());
      expect(result.data.total).toBe(3);
      expect(mockState.vars.lastSupportTicketComments.comments).toHaveLength(3);
    });

    it("can exclude replies", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        {
          id: "comment-1",
          text: "Top level",
          createdAt: new Date("2026-01-01T08:00:00.000Z"),
          author: { id: "user-1", name: "Alice Smith" },
          parentId: null,
          attachments: [],
        },
        {
          id: "comment-2",
          text: "A reply",
          createdAt: new Date("2026-01-02T09:30:00.000Z"),
          author: { id: "user-2", name: "Bob Builder" },
          parentId: "comment-1",
          attachments: [],
        },
      ]);

      const result = await GetSupportTicketComments(
        { ticketId: TICKET_ID, includeReplies: false },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data.comments.map((comment: any) => comment.id)).toEqual(["comment-1"]);
      expect(result.data.includeReplies).toBe(false);
    });

    it("resolves a ticket reference to its ObjectId before reading comments", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 1, hasNext: false },
        tickets: [{ _id: TICKET_ID, reference: REFERENCE }],
      });
      mockSupportService.getTicketComments.mockResolvedValue([]);

      const result = await GetSupportTicketComments(
        { ticketId: REFERENCE.toLowerCase() },
        mockState
      );

      expect(result.success).toBe(true);
      expect(result.data.lookup).toBe("reference");
      expect(result.data.reference).toBe(REFERENCE);
      expect(result.data.ticketId).toBe(TICKET_ID);
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
      expect(mockSupportService.pagedRequest).toHaveBeenCalledWith(
        { reference: [REFERENCE.toLowerCase(), REFERENCE] },
        { page: 1, pageSize: 1 }
      );
      // The read method takes an ObjectId — never the reference.
      expect(mockSupportService.getTicketComments).toHaveBeenCalledWith(TICKET_ID);
    });

    it("reports not found for an unknown reference", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 0, hasNext: false },
        tickets: [],
      });

      const result = await GetSupportTicketComments({ ticketId: "NO-SUCH-REF" }, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("reference NO-SUCH-REF");
      expect(mockSupportService.getTicketComments).not.toHaveBeenCalled();
    });
  });

  describe("GetSupportTicketAttachments", () => {
    it("returns resolved attachment metadata", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.listTicketDocuments.mockResolvedValue([
        fileView(),
        fileView({ id: UPLOADED_FILE_ID, filename: "trace.log", alias: null, url: "/files/trace.log", size: 512, mimetype: "text/plain" }),
      ]);

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(mockSupportService.listTicketDocuments).toHaveBeenCalledWith(TICKET_ID);
      expect(result.data.total).toBe(2);
      expect(result.data.attachments[0]).toEqual(fileView());
      expect(result.data.attachments[1]).toEqual({
        id: UPLOADED_FILE_ID,
        filename: "trace.log",
        alias: null,
        url: "/files/trace.log",
        size: 512,
        mimetype: "text/plain",
      });
      expect(mockState.vars.lastSupportTicketAttachments.attachments).toHaveLength(2);
    });

    it("returns an empty list when the ticket has no attachments", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.listTicketDocuments.mockResolvedValue([]);

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.attachments).toEqual([]);
      expect(result.data.total).toBe(0);
    });
  });

  describe("AttachSupportTicketFile", () => {
    let workspaceRoot: string;
    const originalWorkspaceRoot = process.env.REACTOR_AGENT_WORKSPACE;

    // `fs.rmSync` is not in this repo's @types/node (v10); walk the tree instead.
    const removeDirectory = (directory: string): void => {
      fs.readdirSync(directory).forEach((entry) => {
        const entryPath = path.join(directory, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          removeDirectory(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      });
      fs.rmdirSync(directory);
    };

    beforeEach(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-attach-"));
      process.env.REACTOR_AGENT_WORKSPACE = workspaceRoot;
    });

    afterEach(() => {
      if (originalWorkspaceRoot === undefined) {
        delete process.env.REACTOR_AGENT_WORKSPACE;
      } else {
        process.env.REACTOR_AGENT_WORKSPACE = originalWorkspaceRoot;
      }
      removeDirectory(workspaceRoot);
    });

    it("attaches an existing file by id and returns the updated attachment list", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([
        fileView(),
        fileView({ id: UPLOADED_FILE_ID, filename: "notes.txt", alias: null, url: "/files/notes.txt", size: 14, mimetype: "text/plain" }),
      ]);

      const props = { ticketId: TICKET_ID, fileId: FILE_ID };
      const result = await AttachSupportTicketFile(props, mockState);

      expect(result.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [FILE_ID]);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(result.data.attached).toEqual({
        fileId: FILE_ID,
        mode: "fileId",
        filename: null,
        size: null,
        mimetype: null,
      });
      expect(result.data.total).toBe(2);
      expect(result.data.attachments.map((attachment: any) => attachment.id)).toEqual([
        FILE_ID,
        UPLOADED_FILE_ID,
      ]);
      expect(mockState.vars.lastSupportTicketAttachments.attachments).toHaveLength(2);
    });

    it("resolves a ticket reference before attaching", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 1, hasNext: false },
        tickets: [{ _id: TICKET_ID, reference: REFERENCE }],
      });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView()]);

      const result = await AttachSupportTicketFile(
        { ticketId: REFERENCE, fileId: FILE_ID },
        mockState
      );

      expect(result.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [FILE_ID]);
      expect(result.data.lookup).toBe("reference");
    });

    it("uploads a workspace file and then attaches the uploaded id", async () => {
      const relativePath = path.join("evidence", "notes.txt");
      fs.mkdirSync(path.join(workspaceRoot, "evidence"), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, relativePath), "hello evidence");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({
        _id: UPLOADED_FILE_ID,
        filename: "notes.txt",
        size: 14,
        mimetype: "text/plain",
      });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([
        fileView({ id: UPLOADED_FILE_ID, filename: "notes.txt", alias: null, url: "/files/notes.txt", size: 14, mimetype: "text/plain" }),
      ]);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: relativePath, name: "evidence-notes" },
        mockState
      );

      expect(result.success).toBe(true);
      expect(mockFileService.uploadFile).toHaveBeenCalledTimes(1);
      const uploadArgs = mockFileService.uploadFile.mock.calls[0][0];
      expect(uploadArgs.file.filename).toBe("notes.txt");
      expect(uploadArgs.file.mimetype).toBe("text/plain");
      expect(typeof uploadArgs.file.createReadStream).toBe("function");
      expect(uploadArgs.filename).toBe("evidence-notes");
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [UPLOADED_FILE_ID]);
      expect(result.data.attached.mode).toBe("path");
      expect(result.data.attached.fileId).toBe(UPLOADED_FILE_ID);
      expect(result.data.total).toBe(1);
    });

    it("rejects path traversal before uploading anything", async () => {
      // Pass the traversal literally: path.join() would normalise it away.
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "../secrets.txt" },
        mockState
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/path traversal/i);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("rejects an absolute path outside the agent workspace", async () => {
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "/etc/hosts" },
        mockState
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside the agent workspace/i);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("rejects a file larger than the attachment cap", async () => {
      const oversized = path.join(workspaceRoot, "oversized.bin");
      const handle = fs.openSync(oversized, "w");
      fs.ftruncateSync(handle, MAX_ATTACHMENT_BYTES + 1);
      fs.closeSync(handle);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "oversized.bin" },
        mockState
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(String(MAX_ATTACHMENT_BYTES));
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("requires exactly one of fileId or path", async () => {
      const neither = await AttachSupportTicketFile({ ticketId: TICKET_ID }, mockState);
      expect(neither.success).toBe(false);
      expect(neither.error).toMatch(/either 'fileId'/i);

      const both = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, fileId: FILE_ID, path: "notes.txt" },
        mockState
      );
      expect(both.success).toBe(false);
      expect(both.error).toMatch(/not both/i);
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });
  });

  describe("TOOLS-002 failure envelopes", () => {
    it("getSupportTicketComments returns a failure envelope when the service is unavailable", async () => {
      const props = { ticketId: TICKET_ID };
      const result = await GetSupportTicketComments(props, stateWithoutSupportService());

      expectFailureEnvelope(result, "getSupportTicketComments", props);
      expect(result.error).toContain("ReactorySupportService not found");
    });

    it("getSupportTicketAttachments returns a failure envelope when the service is unavailable", async () => {
      const props = { ticketId: TICKET_ID };
      const result = await GetSupportTicketAttachments(props, stateWithoutSupportService());

      expectFailureEnvelope(result, "getSupportTicketAttachments", props);
      expect(result.error).toContain("ReactorySupportService not found");
    });

    it("attachSupportTicketFile returns a failure envelope when the service is unavailable", async () => {
      const props = { ticketId: TICKET_ID, fileId: FILE_ID };
      const result = await AttachSupportTicketFile(props, stateWithoutSupportService());

      expectFailureEnvelope(result, "attachSupportTicketFile", props);
      expect(result.error).toContain("ReactorySupportService not found");
    });

    it("returns a failure envelope, not a throw, when the service rejects", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockRejectedValue(new Error("InsufficientPermissions"));

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("InsufficientPermissions");
      expect(result.tool).toBe("getSupportTicketComments");
    });
  });
});
