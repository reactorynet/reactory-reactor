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
    let outsideRoot: string;
    const originalWorkspaceRoot = process.env.REACTOR_AGENT_WORKSPACE;

    // `fs.rmSync` is not in this repo's @types/node (v10); walk the tree instead.
    const removeDirectory = (directory: string): void => {
      fs.readdirSync(directory).forEach((entry) => {
        const entryPath = path.join(directory, entry);
        // Unlink symlinks rather than following them - the link target is outside
        // the tree being removed.
        if (fs.lstatSync(entryPath).isDirectory()) {
          removeDirectory(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      });
      fs.rmdirSync(directory);
    };

    beforeEach(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-attach-"));
      outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-outside-"));
      // The sandbox root is per-execution state, not a global default. Seeding it
      // on the state is how the dispatcher supplies the ticket worktree.
      mockState.vars.worktreePath = workspaceRoot;
      delete process.env.REACTOR_AGENT_WORKSPACE;
    });

    afterEach(() => {
      if (originalWorkspaceRoot === undefined) {
        delete process.env.REACTOR_AGENT_WORKSPACE;
      } else {
        process.env.REACTOR_AGENT_WORKSPACE = originalWorkspaceRoot;
      }
      delete mockState.vars.worktreePath;
      removeDirectory(workspaceRoot);
      removeDirectory(outsideRoot);
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

  /*
   * The path sandbox is the only thing standing between an agent that reads
   * untrusted ticket comments and the host filesystem, so it is pinned here
   * rather than left to the happy-path test above.
   */
  describe("AttachSupportTicketFile — workspace sandbox", () => {
    let workspaceRoot: string;
    let outsideRoot: string;

    const removeDirectory = (directory: string): void => {
      fs.readdirSync(directory).forEach((entry) => {
        const entryPath = path.join(directory, entry);
        if (fs.lstatSync(entryPath).isDirectory()) {
          removeDirectory(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      });
      fs.rmdirSync(directory);
    };

    const stateWith = (vars: Record<string, unknown>, fileService: any = mockFileService) =>
      createMockState({
        context: {
          getService: jest.fn((serviceId: string) => {
            if (serviceId === "core.ReactorySupportService@1.0.0") return mockSupportService;
            if (serviceId === "core.ReactoryFileService@1.0.0") return fileService;
            return null;
          }),
        } as any,
        user: { id: "user-123" },
        vars,
      });

    beforeEach(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-sandbox-"));
      outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-sandbox-outside-"));
      delete process.env.REACTOR_AGENT_WORKSPACE;
    });

    afterEach(() => {
      delete process.env.REACTOR_AGENT_WORKSPACE;
      removeDirectory(workspaceRoot);
      removeDirectory(outsideRoot);
    });

    it("rejects an absolute path inside process.cwd() but outside the worktree", async () => {
      // The exact exfiltration route the review found: the server checkout's own
      // .env, addressed absolutely, was inside a process.cwd()-rooted sandbox.
      const serverEnv = path.join(process.cwd(), ".env");

      const state = stateWith({ worktreePath: workspaceRoot });
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: serverEnv },
        state
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside the agent workspace/i);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
      // The guard runs before the ticket lookup, so a host path costs no work.
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
    });

    it("fails closed when no workspace root is configured", async () => {
      const props = { ticketId: TICKET_ID, path: "notes.txt" };
      const result = await AttachSupportTicketFile(props, stateWith({}));

      expectFailureEnvelope(result, "attachSupportTicketFile", props);
      expect(result.error).toContain("No agent workspace configured");
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
    });

    it("fails closed when the configured root is not an existing directory", async () => {
      const notADirectory = path.join(workspaceRoot, "notes.txt");
      fs.writeFileSync(notADirectory, "not a directory");

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "notes.txt" },
        stateWith({ worktreePath: notADirectory })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No agent workspace configured");
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
    });

    it("rejects a symlink inside the workspace that points outside it", async () => {
      const secret = path.join(outsideRoot, "secret.txt");
      fs.writeFileSync(secret, "host secret");
      fs.symlinkSync(secret, path.join(workspaceRoot, "link.txt"));

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "link.txt" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/resolves outside the agent workspace/i);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("accepts REACTOR_AGENT_WORKSPACE when the session carries no worktreePath", async () => {
      process.env.REACTOR_AGENT_WORKSPACE = workspaceRoot;
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID, filename: "notes.txt" });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: UPLOADED_FILE_ID })]);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "notes.txt" },
        stateWith({})
      );

      expect(result.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [UPLOADED_FILE_ID]);
    });

    it("accepts an absolute path that is genuinely inside the workspace", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: UPLOADED_FILE_ID })]);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: path.join(workspaceRoot, "notes.txt") },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [UPLOADED_FILE_ID]);
    });

    it("accepts an absolute in-workspace path spelled through a symlinked root", async () => {
      // /var -> /private/var on macOS and symlinked checkouts on CI: the configured
      // root is canonicalised, so a non-canonical absolute spelling of a file that
      // really is inside it must not be rejected as outside.
      const linkRoot = path.join(outsideRoot, "workspace-link");
      fs.symlinkSync(workspaceRoot, linkRoot, "dir");
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: UPLOADED_FILE_ID })]);

      // The symlinked spelling is inside the workspace, and now accepted.
      const viaLink = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: path.join(linkRoot, "notes.txt") },
        stateWith({ worktreePath: linkRoot })
      );

      expect(viaLink.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [UPLOADED_FILE_ID]);

      // A canonical root with a non-canonical absolute candidate also works.
      mockSupportService.attachDocument.mockClear();
      const mixed = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: path.join(linkRoot, "notes.txt") },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(mixed.success).toBe(true);
      expect(mockSupportService.attachDocument).toHaveBeenCalledWith(TICKET_ID, [UPLOADED_FILE_ID]);
    });

    it("still rejects a symlinked root's outside neighbour", async () => {
      // The false-negative fix must not widen the boundary: a sibling of the
      // symlinked workspace is still outside it.
      const linkRoot = path.join(outsideRoot, "workspace-link");
      fs.symlinkSync(workspaceRoot, linkRoot, "dir");
      fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "host secret");

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: path.join(outsideRoot, "secret.txt") },
        stateWith({ worktreePath: linkRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside the agent workspace/i);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
    });

    it("ignores an empty worktreePath and still fails closed", async () => {
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "notes.txt" },
        stateWith({ worktreePath: "   " })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No agent workspace configured");
    });

    it("returns a failure envelope when the file service is unavailable in path mode", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());

      const props = { ticketId: TICKET_ID, path: "notes.txt" };
      const result = await AttachSupportTicketFile(props, stateWith({ worktreePath: workspaceRoot }, null));

      expectFailureEnvelope(result, "attachSupportTicketFile", props);
      expect(result.error).toContain("ReactoryFileService not found");
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("fails when the upload returns no file id", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({});

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "notes.txt" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("did not return a file id");
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("fails when fileId mode cannot confirm the id landed on the ticket", async () => {
      // attachDocument silently ignores unknown ids, so a resolved promise is not
      // proof of attachment. The macro must verify against the ticket's own list.
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: UPLOADED_FILE_ID })]);

      const props = { ticketId: TICKET_ID, fileId: FILE_ID };
      const result = await AttachSupportTicketFile(props, stateWith({ worktreePath: workspaceRoot }));

      expect(result.success).toBe(false);
      expect(result.error).toContain(FILE_ID);
      expect(result.error).toContain("was not found");
      expect(result.metadata.attachedFileId).toBe(FILE_ID);
    });

    it("distinguishes a missing fileId from a rejected one before attaching", async () => {
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, fileId: "not-an-object-id" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a Reactory file id/i);
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("reports an unresolved reference without touching the ticket", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 0, hasNext: false },
        tickets: [],
      });

      const result = await AttachSupportTicketFile(
        { ticketId: "NO-SUCH-REF", fileId: FILE_ID },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("reference NO-SUCH-REF not found");
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });

    it("reports file-not-found when the parent directory does not exist", async () => {
      // Exercises the canonicaliseParent fallback: realpathSync on a missing
      // parent throws, the path is kept as given, and the existence check then
      // produces the accurate error instead of an 'outside the workspace' one.
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: path.join("no-such-dir", "notes.txt") },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
    });

    it("rejects a missing file inside the workspace", async () => {
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "nope.txt" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found: nope.txt");
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
    });

    it("rejects the workspace root itself because it is not a file", async () => {
      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "." },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^Not a file: \.$/);
      expect(mockFileService.uploadFile).not.toHaveBeenCalled();
    });

    it("uploads a file whose extension has no known MIME type", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "blob.weirdext"), "bytes");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: UPLOADED_FILE_ID })]);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "blob.weirdext" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(true);
      expect(mockFileService.uploadFile.mock.calls[0][0].file.mimetype).toBe("application/octet-stream");
    });

    it("fails when an uploaded file does not appear on the ticket", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "hello evidence");

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView({ id: FILE_ID })]);

      const result = await AttachSupportTicketFile(
        { ticketId: TICKET_ID, path: "notes.txt" },
        stateWith({ worktreePath: workspaceRoot })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("did not appear on ticket");
      expect(result.metadata.uploadedFileId).toBe(UPLOADED_FILE_ID);
    });
  });

  describe("TOOLS-002 input validation and not-found paths", () => {
    const blankIdCases: Array<[string, any, string]> = [
      ["getSupportTicketComments", GetSupportTicketComments, "getSupportTicketComments"],
      ["getSupportTicketAttachments", GetSupportTicketAttachments, "getSupportTicketAttachments"],
      ["attachSupportTicketFile", AttachSupportTicketFile, "attachSupportTicketFile"],
    ];

    it.each(blankIdCases)("%s rejects a blank ticketId", async (_label, macro, tool) => {
      const props: any = { ticketId: "   ", fileId: FILE_ID };
      const result = await macro(props, mockState);

      expectFailureEnvelope(result, tool, props);
      expect(result.error).toContain("No ticket ID provided");
      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
    });

    const objectIdCases: Array<[string, any, any, string]> = [
      ["getSupportTicketComments", GetSupportTicketComments, { ticketId: TICKET_ID }, "getSupportTicketComments"],
      ["getSupportTicketAttachments", GetSupportTicketAttachments, { ticketId: TICKET_ID }, "getSupportTicketAttachments"],
      ["attachSupportTicketFile", AttachSupportTicketFile, { ticketId: TICKET_ID, fileId: FILE_ID }, "attachSupportTicketFile"],
    ];

    it.each(objectIdCases)(
      "%s reports not found when getTicket returns null for a valid ObjectId",
      async (_label, macro, props, tool) => {
        mockSupportService.getTicket.mockResolvedValue(null);

        const result = await macro(props, mockState);

        expectFailureEnvelope(result, tool, props);
        expect(result.error).toContain(`ID ${TICKET_ID} not found`);
        expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
      }
    );

    it("orders comments with identical timestamps deterministically by id", async () => {
      const when = new Date("2026-01-01T08:00:00.000Z");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-b", text: "second", createdAt: when, author: { id: "u", name: "B" }, parentId: null, attachments: [] },
        { id: "comment-a", text: "first", createdAt: when, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.comments.map((comment: any) => comment.id)).toEqual(["comment-a", "comment-b"]);
    });

    it("reports the true reply count when replies are filtered out", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-1", text: "top", createdAt: new Date("2026-01-01T08:00:00.000Z"), author: { id: "u1", name: "A" }, parentId: null, attachments: [] },
        { id: "comment-2", text: "reply", createdAt: new Date("2026-01-02T08:00:00.000Z"), author: { id: "u2", name: "B" }, parentId: "comment-1", attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID, includeReplies: false }, mockState);

      expect(result.data.comments).toHaveLength(1);
      // replyCount is computed before filtering, so the block tells the truth.
      expect(result.instructions).toContain("**Replies**: 1");
    });
  });

  /*
   * Defensive normalisation and payload-shape handling. The service contracts
   * promise these fields, but a populate miss or an older record can leave them
   * absent, and the transcript must still be readable rather than printing
   * "undefined" at the model.
   */
  describe("TOOLS-002 payload tolerance", () => {
    it("renders a transcript for comments and files with sparse fields", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        // No id (falls back to _id), no text, no createdAt, no author,
        // no attachments array at all.
        { _id: "comment-sparse", parentId: null },
        // Author with no name (falls back to id), attachments with link-only url,
        // alias-only name, null size and no mimetype.
        {
          id: "comment-partial",
          text: "See attached",
          createdAt: new Date("2026-01-05T08:00:00.000Z"),
          author: { id: "user-9" },
          parentId: "comment-sparse",
          attachments: [{ _id: FILE_ID, alias: "Alias only", link: "/files/alias.bin", size: null }],
        },
        // Neither name nor id on the author.
        {
          id: "comment-anonymous",
          text: "Anonymous note",
          createdAt: new Date("2026-01-06T08:00:00.000Z"),
          author: { name: null, id: null },
          parentId: null,
          attachments: [],
        },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      // Comments without a timestamp sort last, so the ordered thread is
      // partial (01-05) -> anonymous (01-06) -> sparse (no timestamp).
      const [partial, anonymous, sparse] = result.data.comments;

      expect(sparse.id).toBe("comment-sparse");
      expect(sparse.text).toBe("");
      expect(sparse.createdAt).toBeNull();
      expect(sparse.author).toEqual({ id: null, name: null });
      expect(sparse.attachments).toEqual([]);

      expect(partial.author).toEqual({ id: "user-9", name: null });
      expect(partial.attachments[0]).toEqual({
        id: FILE_ID,
        filename: null,
        alias: "Alias only",
        url: "/files/alias.bin",
        size: null,
        mimetype: null,
      });

      // Comments without a timestamp sort last, not to 1970.
      expect(result.data.comments.map((comment: any) => comment.id)).toEqual([
        "comment-partial",
        "comment-anonymous",
        "comment-sparse",
      ]);

      // The transcript falls back for every missing field instead of printing null.
      expect(result.instructions).toContain("unknown time");
      // Sparse comment has no author name or id.
      expect(result.instructions).toContain("Unknown author");
      expect(result.instructions).toContain("(reply to comment-sparse)");
      expect(result.instructions).toContain("[1 attachment(s)]");
    });

    it("falls back to the ticket id when the ticket has no usable reference", async () => {
      mockSupportService.getTicket.mockResolvedValue({ _id: TICKET_ID, reference: 42 });
      mockSupportService.getTicketComments.mockResolvedValue([]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.reference).toBeNull();
      expect(result.instructions).toContain(TICKET_ID);
      expect(result.instructions).toContain("**Reference**: N/A");
      expect(result.instructions).toContain("No comments on this ticket yet.");
    });

    it("falls back to the ticket id when the resolved ticket has no id at all", async () => {
      mockSupportService.getTicket.mockResolvedValue({ reference: REFERENCE });
      mockSupportService.getTicketComments.mockResolvedValue([]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      // Falls back to the caller's id rather than failing the lookup.
      expect(result.success).toBe(true);
      expect(result.data.ticketId).toBe(TICKET_ID);
      expect(mockSupportService.getTicketComments).toHaveBeenCalledWith(TICKET_ID);
    });

    it("drops a reference whose resolution yields no ticket id", async () => {
      mockSupportService.pagedRequest.mockResolvedValue({
        paging: { page: 1, pageSize: 1, total: 1, hasNext: false },
        tickets: [{ reference: REFERENCE }],
      });

      const result = await GetSupportTicketAttachments({ ticketId: REFERENCE }, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`reference ${REFERENCE} not found`);
      expect(mockSupportService.listTicketDocuments).not.toHaveBeenCalled();
    });

    it("treats a non-array comments payload as an empty thread", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue(null);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.comments).toEqual([]);
    });

    it("treats a non-array documents payload as no attachments", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.listTicketDocuments.mockResolvedValue(undefined);

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.attachments).toEqual([]);
    });

    it("works when the session has no vars bag yet", async () => {
      const bareState: any = createMockState({
        context: {
          getService: jest.fn((serviceId: string) =>
            serviceId === "core.ReactorySupportService@1.0.0" ? mockSupportService : null
          ),
        } as any,
        user: { id: "user-123" },
      });
      delete bareState.vars;

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([]);
      mockSupportService.listTicketDocuments.mockResolvedValue([]);

      const comments = await GetSupportTicketComments({ ticketId: TICKET_ID }, bareState);
      expect(comments.success).toBe(true);
      expect(bareState.vars.lastSupportTicketComments.ticketId).toBe(TICKET_ID);

      const attachments = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, bareState);
      expect(attachments.success).toBe(true);
      expect(bareState.vars.lastSupportTicketAttachments.ticketId).toBe(TICKET_ID);
    });

    it.each([
      ["getSupportTicketComments", GetSupportTicketComments],
      ["getSupportTicketAttachments", GetSupportTicketAttachments],
      ["attachSupportTicketFile", AttachSupportTicketFile],
    ])("%s tolerates null props", async (_label, macro) => {
      const result = await (macro as any)(null, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No ticket ID provided");
    });

    it.each([
      ["getSupportTicketComments", GetSupportTicketComments, "getSupportTicketComments"],
      ["getSupportTicketAttachments", GetSupportTicketAttachments, "getSupportTicketAttachments"],
      ["attachSupportTicketFile", AttachSupportTicketFile, "attachSupportTicketFile"],
    ])("%s returns a failure envelope for a non-string ticketId", async (_label, macro, tool) => {
      // Hand-built macro expressions can bypass the tool JSON schema, so a number
      // or object must produce the envelope rather than a TypeError from .trim().
      for (const badId of [42, {}, [], true]) {
        const props: any = { ticketId: badId, fileId: FILE_ID };
        const result = await (macro as any)(props, mockState);

        expectFailureEnvelope(result, tool, props);
        expect(result.success).toBe(false);
        expect(result.error).toContain("No ticket ID provided");
      }

      expect(mockSupportService.getTicket).not.toHaveBeenCalled();
      expect(mockSupportService.attachDocument).not.toHaveBeenCalled();
    });
    it.each([
      ["getSupportTicketComments", GetSupportTicketComments],
      ["getSupportTicketAttachments", GetSupportTicketAttachments],
      ["attachSupportTicketFile", AttachSupportTicketFile],
    ])("%s reports Unknown error when the service rejects with a non-Error", async (_label, macro) => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockRejectedValue("plain string rejection");
      mockSupportService.listTicketDocuments.mockRejectedValue("plain string rejection");
      mockSupportService.attachDocument.mockRejectedValue("plain string rejection");

      const result = await (macro as any)({ ticketId: TICKET_ID, fileId: FILE_ID }, mockState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown error");
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

  /*
   * Branch coverage for the remaining defensive paths: sparse ids, duplicate
   * ids in the ordering comparison, Error vs non-Error rejections, and the
   * attachments macro's reference fallbacks.
   */
  describe("TOOLS-002 remaining defensive paths", () => {
    it("normalises records that carry neither id nor _id", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        {
          text: "no id at all",
          createdAt: new Date("2026-01-01T08:00:00.000Z"),
          author: { id: "u1", name: "A" },
          parentId: null,
          attachments: [{ filename: "thing.txt" }],
        },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      // No id, no url and no link: every fallback resolves to its neutral value.
      expect(result.data.comments[0].id).toBe("");
      expect(result.data.comments[0].attachments[0]).toEqual({
        id: "",
        filename: "thing.txt",
        alias: null,
        url: null,
        size: null,
        mimetype: null,
      });
      // A file with neither filename nor alias still names itself in the list
      // (rendered by getSupportTicketAttachments, covered below).
    });

    it("breaks a same-timestamp tie by id in both directions", async () => {
      const when = new Date("2026-01-01T08:00:00.000Z");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-b", text: "b", createdAt: when, author: { id: "u", name: "B" }, parentId: null, attachments: [] },
        { id: "comment-a", text: "a", createdAt: when, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.data.comments.map((comment: any) => comment.id)).toEqual(["comment-a", "comment-b"]);
    });

    it("keeps the input order for two distinct records that tie on timestamp and id", async () => {
      const when = new Date("2026-01-01T08:00:00.000Z");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      // Two entries with the same id and timestamp: the comparator returns 0 and
      // must not corrupt the result. Both also lack a timestamp on the other side
      // of the comparison, exercising the null-timestamp sort key.
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-dup", text: "first copy", createdAt: when, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
        { id: "comment-dup", text: "second copy", createdAt: when, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.data.comments).toHaveLength(2);
      expect(result.data.comments.map((comment: any) => comment.text)).toEqual(["first copy", "second copy"]);
    });

    it("sorts two timestamp-less comments deterministically", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-z", text: "z", createdAt: null, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
        { id: "comment-y", text: "y", createdAt: null, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.data.comments.map((comment: any) => comment.id)).toEqual(["comment-y", "comment-z"]);
    });

    it("falls back to the ticket id in the attachments block when there is no reference", async () => {
      mockSupportService.getTicket.mockResolvedValue({ _id: TICKET_ID, reference: 42 });
      mockSupportService.listTicketDocuments.mockResolvedValue([]);

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.reference).toBeNull();
      expect(result.instructions).toContain(TICKET_ID);
      expect(result.instructions).toContain("**Reference**: N/A");
      expect(result.instructions).toContain("This ticket has no attachments.");
    });

    it("surfaces the Error message for every macro", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockRejectedValue(new Error("comments exploded"));
      mockSupportService.listTicketDocuments.mockRejectedValue(new Error("documents exploded"));
      mockSupportService.attachDocument.mockRejectedValue(new Error("attach exploded"));

      const comments = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);
      expect(comments.error).toContain("comments exploded");

      const attachments = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);
      expect(attachments.error).toContain("documents exploded");

      const attach = await AttachSupportTicketFile({ ticketId: TICKET_ID, fileId: FILE_ID }, mockState);
      expect(attach.error).toContain("attach exploded");
    });

    it("reports Unknown error for a non-Error rejection from every read", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockRejectedValue("string");
      mockSupportService.listTicketDocuments.mockRejectedValue("string");

      const comments = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);
      expect(comments.error).toContain("Unknown error");

      const attachments = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);
      expect(attachments.error).toContain("Unknown error");
    });

    it("treats a non-array document payload as no attachments when attaching", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue(null);

      const result = await AttachSupportTicketFile({ ticketId: TICKET_ID, fileId: FILE_ID }, mockState);

      // The id cannot be confirmed, so this is a failure rather than a silent success.
      expect(result.success).toBe(false);
      expect(result.error).toContain(FILE_ID);
    });

    it("records the uploaded file id when the upload succeeds but a later step throws", async () => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reactor-late-fail-"));
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "bytes");
      delete process.env.REACTOR_AGENT_WORKSPACE;

      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockFileService.uploadFile.mockResolvedValue({ _id: UPLOADED_FILE_ID });
      mockSupportService.attachDocument.mockRejectedValue(new Error("attach exploded"));

      const state = createMockState({
        context: {
          getService: jest.fn((serviceId: string) => {
            if (serviceId === "core.ReactorySupportService@1.0.0") return mockSupportService;
            if (serviceId === "core.ReactoryFileService@1.0.0") return mockFileService;
            return null;
          }),
        } as any,
        user: { id: "user-123" },
        vars: { worktreePath: workspaceRoot },
      });

      // No vars bag: the macro must create one.
      delete (state as any).vars;
      (state as any).vars = { worktreePath: workspaceRoot };

      const result = await AttachSupportTicketFile({ ticketId: TICKET_ID, path: "notes.txt" }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain("attach exploded");
      // The orphaned upload is surfaced so the caller can clean it up.
      expect(result.metadata.uploadedFileId).toBe(UPLOADED_FILE_ID);

      fs.unlinkSync(path.join(workspaceRoot, "notes.txt"));
      fs.rmdirSync(workspaceRoot);
    });

    it("creates the vars bag when attaching with a bare session", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView()]);

      const bareState: any = createMockState({
        context: {
          getService: jest.fn((serviceId: string) =>
            serviceId === "core.ReactorySupportService@1.0.0" ? mockSupportService : null
          ),
        } as any,
        user: { id: "user-123" },
      });
      delete bareState.vars;

      const result = await AttachSupportTicketFile({ ticketId: TICKET_ID, fileId: FILE_ID }, bareState);

      expect(result.success).toBe(true);
      expect(bareState.vars.lastSupportTicketAttachments.ticketId).toBe(TICKET_ID);
    });

    it("renders attachment metadata with every display fallback", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.listTicketDocuments.mockResolvedValue([
        // No filename, no alias, null size, no mimetype, no url.
        { _id: FILE_ID, filename: null, alias: null, size: null, mimetype: null, url: null },
        // Alias instead of filename, no url.
        { _id: UPLOADED_FILE_ID, alias: "Alias only", size: 10, mimetype: "text/plain" },
      ]);

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.attachments[0].id).toBe(FILE_ID);
      expect(result.instructions).toContain("(unnamed) — unknown size — unknown type");
      expect(result.instructions).toContain("Alias only — 10 bytes — text/plain");
    });

    it("breaks same-timestamp ties by id in both comparison directions", async () => {
      const when = new Date("2026-01-01T08:00:00.000Z");
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.getTicketComments.mockResolvedValue([
        { id: "comment-b", text: "b", createdAt: when, author: { id: "u", name: "B" }, parentId: null, attachments: [] },
        { id: "comment-c", text: "c", createdAt: when, author: { id: "u", name: "C" }, parentId: null, attachments: [] },
        { id: "comment-a", text: "a", createdAt: when, author: { id: "u", name: "A" }, parentId: null, attachments: [] },
      ]);

      const result = await GetSupportTicketComments({ ticketId: TICKET_ID }, mockState);

      expect(result.data.comments.map((comment: any) => comment.id)).toEqual([
        "comment-a",
        "comment-b",
        "comment-c",
      ]);
    });

    it("creates the vars bag when reading attachments with a bare session", async () => {
      mockSupportService.getTicket.mockResolvedValue(ticketDoc());
      mockSupportService.listTicketDocuments.mockResolvedValue([]);

      const bareState: any = createMockState({
        context: {
          getService: jest.fn((serviceId: string) =>
            serviceId === "core.ReactorySupportService@1.0.0" ? mockSupportService : null
          ),
        } as any,
        user: { id: "user-123" },
      });
      delete bareState.vars;

      const result = await GetSupportTicketAttachments({ ticketId: TICKET_ID }, bareState);

      expect(result.success).toBe(true);
      expect(bareState.vars.lastSupportTicketAttachments.ticketId).toBe(TICKET_ID);
    });

    it("uses the ticket id in the attach block when there is no reference", async () => {
      mockSupportService.getTicket.mockResolvedValue({ _id: TICKET_ID, reference: null });
      mockSupportService.attachDocument.mockResolvedValue({});
      mockSupportService.listTicketDocuments.mockResolvedValue([fileView()]);

      const result = await AttachSupportTicketFile({ ticketId: TICKET_ID, fileId: FILE_ID }, mockState);

      expect(result.success).toBe(true);
      expect(result.data.reference).toBeNull();
      expect(result.instructions).toContain(`## File Attached to Ticket ${TICKET_ID}`);
    });
  });
});