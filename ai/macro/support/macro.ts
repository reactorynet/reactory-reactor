import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import Reactory from "@reactorynet/reactory-core";
import {
  GetSupportTicketProps,
  ListSupportTicketsProps,
  CreateSupportTicketProps,
  UpdateSupportTicketProps,
  AddSupportTicketCommentProps,
  GetSupportTicketCommentsProps,
  GetSupportTicketAttachmentsProps,
  AttachSupportTicketFileProps,
  SupportTicketCommentView,
  SupportTicketFileView,
  SupportMacroResult,
} from "./types";
import logger from "@reactory/server-core/logging";
import { ObjectId } from "mongodb";
import { createReadStream, existsSync, realpathSync, statSync } from "fs";
import pathModule from "path";

/**
 * Guard that determines whether a supplied ticket identifier is a MongoDB ObjectId.
 *
 * `ObjectId.isValid` alone is not sufficient: it returns true for ANY 12 byte string
 * (e.g. "ticket-1abcde"), which would send a reference down the `findById` path and
 * resurface the very CastError this guard is here to avoid. Requiring the canonical
 * 24 character hex representation (round-tripping through `new ObjectId(...)`) keeps
 * the two lookup paths unambiguous.
 */
const isObjectIdString = (value: string): boolean =>
  ObjectId.isValid(value) && String(new ObjectId(value)) === value;

/**
 * Retrieves a single support ticket by its ObjectId or human readable reference number.
 *
 * When the supplied identifier is a valid ObjectId the ticket is fetched directly;
 * otherwise it is resolved against the ticket reference index. This guards against
 * the CastError that `findById` raises when a reference number is passed through.
 */
export const GetSupportTicket: Macro<SupportMacroResult, GetSupportTicketProps> = async (
  props: GetSupportTicketProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { id } = props;

  if (!id || id.trim().length === 0) {
    return {
      success: false,
      error: "No ticket ID provided",
      tool: "getSupportTicket",
      params: props,
    };
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return {
      success: false,
      error: "ReactorySupportService not found in execution context",
      tool: "getSupportTicket",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }

  try {
    const ticketId = id.trim();
    const isObjectId = isObjectIdString(ticketId);

    let ticket: Reactory.Models.ReactorySupportDocument | null = null;

    if (isObjectId) {
      ticket = await supportService.getTicket(ticketId);
    } else {
      // The identifier is not a MongoDB ObjectId, so treat it as the human readable
      // ticket reference and resolve it through the reference index. References are
      // stored upper-cased, so query both the raw and upper-cased variants to remain
      // forgiving about how the caller typed it.
      const references = Array.from(new Set([ticketId, ticketId.toUpperCase()]));
      const paged = await supportService.pagedRequest(
        { reference: references },
        { page: 1, pageSize: 1 }
      );
      ticket = (paged?.tickets?.[0] as unknown as Reactory.Models.ReactorySupportDocument) ?? null;
    }

    const executionTime = Date.now() - startTime;

    if (!ticket) {
      return {
        success: false,
        error: `Ticket with ${isObjectId ? "ID" : "reference"} ${ticketId} not found`,
        tool: "getSupportTicket",
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          lookup: isObjectId ? "id" : "reference",
        },
      };
    }

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTicket = ticket;

    return {
      success: true,
      data: ticket,
      tool: "getSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
      instructions: `
## Support Ticket Details

- **ID**: ${ticket.id || (ticket as any)._id}
- **Reference**: ${ticket.reference || "N/A"}
- **Request**: ${ticket.request}
- **Status**: ${ticket.status}
- **Priority**: ${ticket.priority || "medium"}
- **Request Type**: ${ticket.requestType || "general"}
- **Created By**: ${(ticket.createdBy as any)?.firstName} ${(ticket.createdBy as any)?.lastName} (${(ticket.createdBy as any)?.email})
- **Assigned To**: ${ticket.assignedTo ? `${(ticket.assignedTo as any)?.firstName} ${(ticket.assignedTo as any)?.lastName}` : "Unassigned"}
- **Description**: ${ticket.description}
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in GetSupportTicket macro for ID ${id}:`, error);

    return {
      success: false,
      error: `Error retrieving support ticket: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "getSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }
};

export const GetSupportTicketRegistry: MacroComponentDefinition<typeof GetSupportTicket> = {
  nameSpace: "reactor-macros",
  name: "getSupportTicket",
  version: "1.0.0",
  component: GetSupportTicket,
  description: "Retrieve a support ticket by ObjectId or human-readable reference number with full details, comments, and assignee metadata",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "get", "inquiry"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getSupportTicket",
        description: "Retrieve a support ticket by ObjectId or human-readable reference number. Pass either the ticket's ObjectId or its reference (e.g. 'ACME-1A2B/20260101/9F8E'); non-ObjectId values are resolved against the ticket reference index.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The support ticket's ObjectId (24 char hex) or its human-readable reference number",
            },
          },
          required: ["id"],
        },
      },
    },
  ],
};

/**
 * Lists and filters support tickets with pagination
 */
export const ListSupportTickets: Macro<SupportMacroResult, ListSupportTicketsProps> = async (
  props: ListSupportTicketsProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const {
    status,
    priority,
    searchString,
    requestType,
    tags,
    assignedTo,
    showOverdueOnly,
    page = 1,
    pageSize = 10,
  } = props || {};

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return {
      success: false,
      error: "ReactorySupportService not found in execution context",
      tool: "listSupportTickets",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }

  try {
    const filter: Partial<Reactory.Models.IReactorySupportTicketFilter> = {
      status,
      priority,
      searchString,
      requestType,
      tags,
      assignedTo,
      showOverdueOnly,
    };

    const paging: Reactory.Models.IPagingRequest = {
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 10,
    };

    const result = await supportService.pagedRequest(filter, paging);
    const executionTime = Date.now() - startTime;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTickets = result;

    const tickets = result?.tickets || [];
    const total = result?.paging?.total || tickets.length;

    const ticketListSummary = tickets
      .map(
        (t: any, idx: number) =>
          `${idx + 1}. [${t.status?.toUpperCase() || "NEW"}] (${t.priority || "normal"}) **${t.request}** (Ref: ${t.reference || t.id || t._id}) - Assigned: ${t.assignedTo ? `${t.assignedTo.firstName} ${t.assignedTo.lastName}` : "Unassigned"}`
      )
      .join("\n");

    return {
      success: true,
      data: result,
      tool: "listSupportTickets",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        total,
        page,
        pageSize,
      },
      instructions: `
## Support Tickets List (Total: ${total}, Page: ${page})

${tickets.length > 0 ? ticketListSummary : "No support tickets found matching the criteria."}
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error("Error in ListSupportTickets macro:", error);

    return {
      success: false,
      error: `Error listing support tickets: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "listSupportTickets",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }
};

export const ListSupportTicketsRegistry: MacroComponentDefinition<typeof ListSupportTickets> = {
  nameSpace: "reactor-macros",
  name: "listSupportTickets",
  version: "1.0.0",
  component: ListSupportTickets,
  description: "List and filter support tickets by status, priority, search keywords, tags, or assignment",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "list", "search", "filter"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "listSupportTickets",
        description: "List and filter support tickets with pagination, status filters, search strings, and tags",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "array",
              items: { type: "string" },
              description: "Filter by ticket statuses (e.g. ['new', 'open', 'in_progress', 'resolved', 'closed'])",
            },
            priority: {
              type: "array",
              items: { type: "string" },
              description: "Filter by priority (e.g. ['critical', 'high', 'medium', 'low'])",
            },
            searchString: {
              type: "string",
              description: "Text search matching request title, description, or reference",
            },
            requestType: {
              type: "array",
              items: { type: "string" },
              description: "Filter by request types",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags",
            },
            assignedTo: {
              type: "array",
              items: { type: "string" },
              description: "Filter by assigned user IDs",
            },
            showOverdueOnly: {
              type: "boolean",
              description: "Whether to only return overdue tickets",
            },
            page: {
              type: "number",
              description: "Page number (1-based, default: 1)",
            },
            pageSize: {
              type: "number",
              description: "Number of tickets per page (default: 10)",
            },
          },
        },
      },
    },
  ],
};

/**
 * Creates a new support ticket
 */
export const CreateSupportTicket: Macro<SupportMacroResult, CreateSupportTicketProps> = async (
  props: CreateSupportTicketProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { request, description, requestType = "support", priority = "medium", formId, meta } = props;

  if (!request || request.trim().length === 0) {
    return {
      success: false,
      error: "No request summary provided",
      tool: "createSupportTicket",
      params: props,
    };
  }

  if (!description || description.trim().length === 0) {
    return {
      success: false,
      error: "No detailed description provided",
      tool: "createSupportTicket",
      params: props,
    };
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return {
      success: false,
      error: "ReactorySupportService not found in execution context",
      tool: "createSupportTicket",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }

  try {
    const ticket = await supportService.createRequest(
      request.trim(),
      description.trim(),
      requestType,
      { ...(meta || {}), priority },
      formId
    );

    const executionTime = Date.now() - startTime;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastCreatedSupportTicket = ticket;

    logger.info(`CreateSupportTicket macro created ticket: ${ticket.reference || ticket.id} by user: ${state.user?.id}`);

    return {
      success: true,
      data: ticket,
      tool: "createSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
      instructions: `
## Support Ticket Created Successfully

- **ID**: ${ticket.id || (ticket as any)._id}
- **Reference**: ${ticket.reference}
- **Request**: ${ticket.request}
- **Status**: ${ticket.status}
- **Priority**: ${priority}
- **Request Type**: ${requestType}
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error("Error in CreateSupportTicket macro:", error);

    return {
      success: false,
      error: `Error creating support ticket: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "createSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }
};

export const CreateSupportTicketRegistry: MacroComponentDefinition<typeof CreateSupportTicket> = {
  nameSpace: "reactor-macros",
  name: "createSupportTicket",
  version: "1.0.0",
  component: CreateSupportTicket,
  description: "Create a new support ticket with title, description, request type, priority, and metadata",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "create", "new", "log"],
  tools: [
    {
      type: "function",
      function: {
        name: "createSupportTicket",
        description: "Create a new support ticket in the Reactory support system",
        parameters: {
          type: "object",
          properties: {
            request: {
              type: "string",
              description: "Short title or summary of the issue/request",
            },
            description: {
              type: "string",
              description: "Comprehensive description of the issue, symptoms, and context",
            },
            requestType: {
              type: "string",
              description: "Type of request (e.g., 'bug', 'feature', 'access', 'round_support', 'general')",
            },
            priority: {
              type: "string",
              description: "Priority level: 'critical', 'high', 'medium', or 'low'",
            },
            formId: {
              type: "string",
              description: "Optional ID of the originating form or context",
            },
            meta: {
              type: "object",
              description: "Optional metadata object containing extra context",
            },
          },
          required: ["request", "description"],
        },
      },
    },
  ],
};

/**
 * Updates a support ticket (status, assignee, priority, tags, comment)
 */
export const UpdateSupportTicket: Macro<SupportMacroResult, UpdateSupportTicketProps> = async (
  props: UpdateSupportTicketProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { ticketId, status, assignTo, priority, comment, request, description, tags } = props;

  if (!ticketId || ticketId.trim().length === 0) {
    return {
      success: false,
      error: "No ticket ID provided",
      tool: "updateSupportTicket",
      params: props,
    };
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return {
      success: false,
      error: "ReactorySupportService not found in execution context",
      tool: "updateSupportTicket",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }

  try {
    const updates: Reactory.Models.IReactorySupportTicketUpdate = {
      status,
      assignTo,
      priority,
      comment,
      request,
      description,
      tags,
    };

    const updatedTicket = await supportService.updateTicket(ticketId.trim(), updates);
    const executionTime = Date.now() - startTime;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastUpdatedSupportTicket = updatedTicket;

    logger.info(`UpdateSupportTicket macro updated ticket ${ticketId} by user: ${state.user?.id}`);

    return {
      success: true,
      data: updatedTicket,
      tool: "updateSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
      instructions: `
## Support Ticket Updated

- **ID**: ${updatedTicket.id || (updatedTicket as any)._id}
- **Status**: ${updatedTicket.status}
- **Priority**: ${updatedTicket.priority}
- **Assigned To**: ${updatedTicket.assignedTo ? `${(updatedTicket.assignedTo as any)?.firstName} ${(updatedTicket.assignedTo as any)?.lastName}` : "Unassigned"}
- **Last Updated**: ${new Date().toISOString()}
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in UpdateSupportTicket macro for ticket ${ticketId}:`, error);

    return {
      success: false,
      error: `Error updating support ticket: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "updateSupportTicket",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }
};

export const UpdateSupportTicketRegistry: MacroComponentDefinition<typeof UpdateSupportTicket> = {
  nameSpace: "reactor-macros",
  name: "updateSupportTicket",
  version: "1.0.0",
  component: UpdateSupportTicket,
  description: "Update a support ticket's status, assignee (user account ID), priority, tags, or add an update comment",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "update", "assign", "status"],
  tools: [
    {
      type: "function",
      function: {
        name: "updateSupportTicket",
        description: "Update an existing support ticket's status, assignee (must be a valid user account ID), priority, or details",
        parameters: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ID of the support ticket to update",
            },
            status: {
              type: "string",
              description: "New status (e.g. 'new', 'in_progress', 'resolved', 'closed', 'delegated')",
            },
            assignTo: {
              type: "string",
              description: "User ID of the assigned user account (ownership must always sit with a user account, not an agent ID). Use searchUser or getUser to look up user IDs.",
            },
            priority: {
              type: "string",
              description: "Priority level ('critical', 'high', 'medium', 'low')",
            },
            comment: {
              type: "string",
              description: "Optional resolution note or update comment to add",
            },
            request: {
              type: "string",
              description: "Updated title/request string",
            },
            description: {
              type: "string",
              description: "Updated detailed description",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Updated array of tags",
            },
          },
          required: ["ticketId"],
        },
      },
    },
  ],
};

/**
 * Adds a comment to an existing support ticket
 */
export const AddSupportTicketComment: Macro<SupportMacroResult, AddSupportTicketCommentProps> = async (
  props: AddSupportTicketCommentProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { ticketId, comment, parentId, attachmentIds } = props;

  if (!ticketId || ticketId.trim().length === 0) {
    return {
      success: false,
      error: "No ticket ID provided",
      tool: "addSupportTicketComment",
      params: props,
    };
  }

  if (!comment || comment.trim().length === 0) {
    return {
      success: false,
      error: "No comment text provided",
      tool: "addSupportTicketComment",
      params: props,
    };
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return {
      success: false,
      error: "ReactorySupportService not found in execution context",
      tool: "addSupportTicketComment",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }

  try {
    const commentDoc = await supportService.addComment(ticketId.trim(), comment.trim(), parentId, attachmentIds);
    const executionTime = Date.now() - startTime;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTicketComment = commentDoc;

    return {
      success: true,
      data: commentDoc,
      tool: "addSupportTicketComment",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
      instructions: `
## Comment Added to Ticket ${ticketId}

- **Comment ID**: ${commentDoc.id || (commentDoc as any)._id}
- **Text**: ${commentDoc.text}
- **Created Date**: ${new Date().toISOString()}
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in AddSupportTicketComment macro for ticket ${ticketId}:`, error);

    return {
      success: false,
      error: `Error adding comment to ticket: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "addSupportTicketComment",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
      },
    };
  }
};

export const AddSupportTicketCommentRegistry: MacroComponentDefinition<typeof AddSupportTicketComment> = {
  nameSpace: "reactor-macros",
  name: "addSupportTicketComment",
  version: "1.0.0",
  component: AddSupportTicketComment,
  description: "Add a comment or triage note to an existing support ticket",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "comment", "reply", "note"],
  tools: [
    {
      type: "function",
      function: {
        name: "addSupportTicketComment",
        description: "Add a comment, triage note, or resolution response to a support ticket",
        parameters: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ID of the support ticket to comment on",
            },
            comment: {
              type: "string",
              description: "The comment text or resolution note",
            },
            parentId: {
              type: "string",
              description: "Optional parent comment ID for threaded replies",
            },
            attachmentIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of attachment file IDs",
            },
          },
          required: ["ticketId", "comment"],
        },
      },
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * TOOLS-002 — reading the ticket conversation, listing its attachments and
 * attaching a file.
 *
 * The five macros above can open, list, create, update and comment on a ticket,
 * but an agent that cannot read the thread (human decisions, review notes,
 * corrections) or the attachments is working half blind, and `addComment`
 * accepts `attachmentIds` that nothing could produce. The three macros below
 * close that gap. They are read/write path only — no GraphQL surface, no model
 * access: every call lands on `core.ReactorySupportService@1.0.0`.
 * ------------------------------------------------------------------------- */

/**
 * The support service surface these macros consume.
 *
 * TOOLS-001 gave `core.ReactorySupportService@1.0.0` populated single-ticket
 * reads plus `getTicketComments(ticketId)` and `listTicketDocuments(ticketId)`,
 * and widened `attachDocument` to take file ids. The published
 * `@reactorynet/reactory-core` typings this module compiles against still carry
 * the old surface (no read methods, and `attachDocument(ticketId, file, name)`),
 * so the macros declare the shape they use here and cast once at the service
 * boundary. The service remains the only thing that touches a model.
 */
interface SupportTicketReadService {
  getTicket(ticketId: string): Promise<Reactory.Models.ReactorySupportDocument>;
  pagedRequest(
    filter: Partial<Reactory.Models.IReactorySupportTicketFilter>,
    paging: Reactory.Models.IPagingRequest
  ): Promise<Reactory.Models.IPagedReactorySupportTickets>;
  getTicketComments(ticketId: string): Promise<SupportTicketCommentView[]>;
  listTicketDocuments(ticketId: string): Promise<SupportTicketFileView[]>;
  attachDocument(ticketId: string, fileIds: string[]): Promise<unknown>;
}

/**
 * The largest file `attachSupportTicketFile` will upload from `path`: 10 MB.
 *
 * Attachments are triage evidence — a screenshot, a log extract, a spreadsheet —
 * not data exports. 10 MB covers all of those and stops a runaway agent from
 * filling the file store with a single tool call.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** MIME type by extension; enough for the evidence an agent actually attaches. */
const MIME_TYPE_BY_EXTENSION: { [extension: string]: string } = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  log: "text/plain",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  zip: "application/zip",
};

const mimeTypeForPath = (filePath: string): string => {
  const extension = pathModule.extname(filePath).toLowerCase().replace(".", "");
  return MIME_TYPE_BY_EXTENSION[extension] || "application/octet-stream";
};

/**
 * The failure every call site returns when `path` mode has no workspace root.
 *
 * Kept in one place so the message cannot drift between the guard and the tests.
 */
export const NO_WORKSPACE_CONFIGURED =
  "No agent workspace configured. Path mode needs the agent worktree root in " +
  "state.vars.worktreePath (supplied by the ticket dispatcher) or in the " +
  "REACTOR_AGENT_WORKSPACE environment variable. Nothing was read, uploaded or attached.";

/**
 * Resolve the root `path` attachments may be read from — per execution, never global.
 *
 * This root is the security boundary of the whole feature, so it is deliberate
 * that there is NO `process.cwd()` fallback. The express-server process cwd is
 * the server checkout, and the per-ticket worktree is a *subdirectory* of it
 * (`<express-server>/src/modules/reactory-worktrees/ai-<ref>`). Rooting at
 * `process.cwd()` therefore made `<express-server>/.env`,
 * `config/reactory/.env.local`, `certs/*` and every other module's source
 * readable and attachable — a prompt-injection route from untrusted ticket
 * comments to host secret exfiltration. `workdir` on the dispatcher also
 * defaults to the server process cwd (ProcessAITicket.yaml), so the cwd was
 * never the worktree in the first place.
 *
 * Candidates are supplied BY THE CALLER, in priority order, so this helper does
 * no environment or cwd lookup of its own:
 *  1. `state.vars.worktreePath` — server-controlled, per-execution state. The
 *     dispatcher computes the ticket worktree path (ProcessAITicket.yaml:
 *     `prepareWorktree` -> `readWorktreePath`) and this is where the run's
 *     workspace is published.
 *  2. `REACTOR_AGENT_WORKSPACE` — a deployment-level pin for hosts that run the
 *     agent outside the dispatcher (CLI, MCP tool-only sessions); read once at
 *     the call site, never here.
 *
 * A candidate only counts if it resolves to an existing directory. When none
 * does, this returns `undefined` and `path` mode fails closed before a byte is
 * read. A caller cannot widen the sandbox from macro parameters: neither source
 * is a tool argument.
 */
const attachmentWorkspaceRoot = (candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;

    const configured = candidate.trim();
    if (configured.length === 0) continue;

    const resolved = pathModule.resolve(configured);

    // The root must already exist: a typo must not degrade into "deny nothing"
    // or, worse, into a cwd-relative guess. `statSync` is inside the try so a
    // missing directory (ENOENT) is just the next candidate, not a throw.
    try {
      if (!statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }

    // Canonicalise before any comparison. The workspace itself can sit behind a
    // symlink (`/tmp` -> `/private/tmp` on macOS, a symlinked checkout in CI);
    // without this every real file resolves to a different prefix and is
    // rejected as "outside the workspace". The entry that survives `statSync`
    // above is always resolvable, so this cannot throw for a candidate we keep;
    // `resolved` is returned defensively if it somehow does.
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  return undefined;
};

/** True when `candidate` is `root` itself or sits underneath it. */
const isInsideDirectory = (root: string, candidate: string): boolean => {
  const relative = pathModule.relative(root, candidate);
  if (relative.length === 0) return true;
  return relative !== ".." && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative);
};

interface ResolvedWorkspaceFile {
  absolutePath: string;
  size: number;
}

/**
 * Either a vetted file or the reason it was rejected — never both, never neither.
 *
 * A discriminated union rather than two optional fields: it lets the call site
 * read `error` without a `|| "something went wrong"` fallback branch that can
 * never be taken, so the failure message is the guard's real reason.
 */
type WorkspaceFileResult =
  | { file: ResolvedWorkspaceFile; error?: undefined }
  | { file?: undefined; error: string };

/**
 * Vet a caller supplied path before anything is read or uploaded.
 *
 * The root is passed in rather than looked up here: it must come from the
 * per-execution state resolved by `attachmentWorkspaceRoot(state)`, and a
 * missing root must fail closed (see `NO_WORKSPACE_CONFIGURED`) rather than
 * silently degrade to the server checkout.
 *
 * Four separate guards, because each one alone is bypassable:
 *  - `..` is rejected up front: `path.resolve` silently collapses it, so a
 *    post-hoc check would hide the attempt instead of reporting it;
 *  - no root means no read at all (fail closed);
 *  - the resolved path must sit inside the workspace root, which stops absolute
 *    host paths (`/etc/passwd`, `<express-server>/.env`) and `~` expansion from
 *    escaping;
 *  - symlinks are resolved and re-checked, so a link planted inside the worktree
 *    cannot point at a host file.
 * The size cap is enforced on the stat result, before a byte is streamed.
 */
const resolveWorkspaceFile = (inputPath: string, root: string | undefined): WorkspaceFileResult => {
  // `path` mode only reaches here when the caller supplied a non-blank string
  // (see `hasPath` in the macro), so this trim needs no empty-string branch.
  const candidate = inputPath.trim();

  if (candidate.split(/[\\/]+/).includes("..")) {
    return { error: "Operation not allowed. Path traversal ('..') detected." };
  }

  // Fail closed. Without a configured workspace there is no boundary to check
  // against, and guessing one (process.cwd()) is exactly the bug this guard
  // exists to prevent.
  if (!root || root.trim().length === 0) {
    return { error: NO_WORKSPACE_CONFIGURED };
  }

  const absolutePath = pathModule.isAbsolute(candidate)
    ? pathModule.normalize(candidate)
    : pathModule.resolve(root, candidate);

  if (!isInsideDirectory(root, absolutePath)) {
    return { error: `Operation not allowed. ${candidate} is outside the agent workspace (${root}). Pass a path relative to the worktree.` };
  }

  if (!existsSync(absolutePath)) return { error: `File not found: ${candidate}` };

  let realPath = absolutePath;
  try {
    realPath = realpathSync(absolutePath);
  } catch {
    // Keep the normalised path; the stat below decides whether it is usable.
  }

  if (!isInsideDirectory(root, realPath)) {
    return { error: `Operation not allowed. ${candidate} resolves outside the agent workspace (${root}).` };
  }

  const stats = statSync(realPath);
  if (!stats.isFile()) return { error: `Not a file: ${candidate}` };

  if (stats.size > MAX_ATTACHMENT_BYTES) {
    return {
      error: `File ${candidate} is ${stats.size} bytes. The attachment limit is ${MAX_ATTACHMENT_BYTES} bytes (10 MB).`,
    };
  }

  return { file: { absolutePath: realPath, size: stats.size } };
};

/** The standard failure envelope. Every support macro returns this, never a throw. */
const supportMacroFailure = (
  tool: string,
  props: unknown,
  state: ChatState,
  startTime: number,
  error: string,
  extra: Record<string, unknown> = {}
): SupportMacroResult => ({
  success: false,
  error,
  tool,
  params: props,
  metadata: {
    executionTime: Date.now() - startTime,
    timestamp: new Date(),
    user: state.user?.id,
    ...extra,
  },
});

const supportTicketIdOf = (ticket: any): string | null => {
  const id = ticket?._id ?? ticket?.id;
  return id === null || id === undefined ? null : String(id);
};

const supportTicketReferenceOf = (ticket: any): string | null => {
  const reference = ticket?.reference;
  return typeof reference === "string" && reference.length > 0 ? reference : null;
};

interface ResolvedSupportTicket {
  /** The canonical ObjectId string every service call must use. */
  ticketId: string;
  ticket: Reactory.Models.ReactorySupportDocument | null;
  lookup: "id" | "reference";
}

/**
 * Resolve a caller supplied identifier to the ObjectId the service expects.
 *
 * Mirrors `getSupportTicket`: a canonical ObjectId goes straight to `getTicket`,
 * anything else is treated as the human readable reference and resolved through
 * the reference index (references are stored upper-cased, so both spellings are
 * queried). This is required, not cosmetic: the read methods take an ObjectId
 * and `findById` raises a CastError when handed a reference.
 */
const resolveSupportTicket = async (
  service: SupportTicketReadService,
  identifier: string
): Promise<ResolvedSupportTicket | null> => {
  const candidate = identifier.trim();

  if (isObjectIdString(candidate)) {
    const ticket = await service.getTicket(candidate);
    if (!ticket) return null;
    return { ticketId: supportTicketIdOf(ticket) || candidate, ticket, lookup: "id" };
  }

  const references = Array.from(new Set([candidate, candidate.toUpperCase()]));
  const paged = await service.pagedRequest({ reference: references }, { page: 1, pageSize: 1 });
  const ticket = ((paged?.tickets?.[0] ?? null) as unknown) as Reactory.Models.ReactorySupportDocument | null;

  if (!ticket) return null;

  const ticketId = supportTicketIdOf(ticket);
  if (!ticketId) return null;

  return { ticketId, ticket, lookup: "reference" };
};

/** Normalise a comment to the shape the agent consumes (never trust optional fields). */
const toCommentView = (comment: any): SupportTicketCommentView => ({
  id: String(comment?.id ?? comment?._id ?? ""),
  text: typeof comment?.text === "string" ? comment.text : "",
  createdAt: comment?.createdAt ? new Date(comment.createdAt) : null,
  author: {
    id: comment?.author?.id ?? null,
    name: comment?.author?.name ?? null,
  },
  parentId: comment?.parentId ?? null,
  attachments: Array.isArray(comment?.attachments) ? comment.attachments.map(toAttachmentView) : [],
});

/** Normalise a file to reader-facing metadata. */
function toAttachmentView(file: any): SupportTicketFileView {
  return {
    id: String(file?.id ?? file?._id ?? ""),
    filename: file?.filename ?? null,
    alias: file?.alias ?? null,
    url: file?.url ?? file?.link ?? null,
    size: typeof file?.size === "number" ? file.size : null,
    mimetype: file?.mimetype ?? null,
  };
}

/**
 * Oldest comment first, ties broken by id.
 *
 * The service already sorts, but the ordering is part of this macro's contract
 * ("read the conversation top to bottom"), so it is asserted here rather than
 * assumed. Comments without a timestamp sort last instead of jumping to 1970.
 */
const orderCommentsOldestFirst = (comments: SupportTicketCommentView[]): SupportTicketCommentView[] =>
  [...comments].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });

const formatCommentTranscript = (comments: SupportTicketCommentView[]): string =>
  comments
    .map((comment, index) => {
      const author = comment.author?.name || comment.author?.id || "Unknown author";
      const when = comment.createdAt ? new Date(comment.createdAt).toISOString() : "unknown time";
      const reply = comment.parentId ? ` (reply to ${comment.parentId})` : "";
      const attachments = comment.attachments.length > 0 ? ` [${comment.attachments.length} attachment(s)]` : "";
      return `${index + 1}. ${when} · ${author}${reply}${attachments}\n   ${comment.text}`;
    })
    .join("\n");

const formatAttachmentList = (attachments: SupportTicketFileView[]): string =>
  attachments
    .map((attachment, index) => {
      const name = attachment.filename || attachment.alias || "(unnamed)";
      const size = attachment.size === null ? "unknown size" : `${attachment.size} bytes`;
      const mimetype = attachment.mimetype || "unknown type";
      const url = attachment.url ? `\n   ${attachment.url}` : "";
      return `${index + 1}. ${name} — ${size} — ${mimetype} — id: ${attachment.id}${url}`;
    })
    .join("\n");

/**
 * Reads the conversation on a support ticket, oldest comment first.
 *
 * Accepts the ticket's ObjectId or its human readable reference. Replies carry
 * the `parentId` of the comment they answer, so a caller can rebuild the thread
 * without a nested tree; `includeReplies: false` returns only top-level comments.
 */
export const GetSupportTicketComments: Macro<SupportMacroResult, GetSupportTicketCommentsProps> = async (
  props: GetSupportTicketCommentsProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { ticketId: identifier, includeReplies = true } = props || ({} as GetSupportTicketCommentsProps);

  if (!identifier || identifier.trim().length === 0) {
    return supportMacroFailure("getSupportTicketComments", props, state, startTime, "No ticket ID provided");
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return supportMacroFailure(
      "getSupportTicketComments",
      props,
      state,
      startTime,
      "ReactorySupportService not found in execution context"
    );
  }

  const service = (supportService as unknown) as SupportTicketReadService;
  const candidate = identifier.trim();

  try {
    const resolved = await resolveSupportTicket(service, candidate);

    if (!resolved) {
      return supportMacroFailure(
        "getSupportTicketComments",
        props,
        state,
        startTime,
        `Ticket with ${isObjectIdString(candidate) ? "ID" : "reference"} ${candidate} not found`,
        { lookup: isObjectIdString(candidate) ? "id" : "reference" }
      );
    }

    const rawComments = await service.getTicketComments(resolved.ticketId);
    const ordered = orderCommentsOldestFirst(
      (Array.isArray(rawComments) ? rawComments : []).map(toCommentView)
    );
    const comments = includeReplies === false ? ordered.filter((comment) => !comment.parentId) : ordered;
    const reference = supportTicketReferenceOf(resolved.ticket);
    // Counted before the `includeReplies` filter: the instructions block reports
    // the thread's true reply count, not how many happened to survive filtering.
    // Reading it off `comments` made `includeReplies: false` always say
    // "Replies: 0" even on a thread full of replies.
    const replyCount = ordered.filter((comment) => comment.parentId).length;

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTicketComments = { ticketId: resolved.ticketId, comments };

    return {
      success: true,
      data: {
        ticketId: resolved.ticketId,
        reference,
        lookup: resolved.lookup,
        includeReplies: includeReplies !== false,
        total: comments.length,
        comments,
      },
      tool: "getSupportTicketComments",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        lookup: resolved.lookup,
        total: comments.length,
      },
      instructions: `
## Ticket Conversation — ${reference || resolved.ticketId}

- **Ticket ID**: ${resolved.ticketId}
- **Reference**: ${reference || "N/A"}
- **Comments**: ${comments.length} (oldest → newest, replies ${includeReplies === false ? "excluded" : "included"})
- **Replies**: ${replyCount}
- **Resolved By**: ${resolved.lookup === "reference" ? "reference lookup" : "ObjectId"}

${comments.length === 0 ? "No comments on this ticket yet." : formatCommentTranscript(comments)}

Reply with addSupportTicketComment, passing parentId to answer a specific comment. Files attached to a comment are listed with their ids in the transcript above.
      `,
    };
  } catch (error) {
    logger.error(`Error in GetSupportTicketComments macro for ticket ${identifier}:`, error);
    return supportMacroFailure(
      "getSupportTicketComments",
      props,
      state,
      startTime,
      `Error retrieving support ticket comments: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

export const GetSupportTicketCommentsRegistry: MacroComponentDefinition<typeof GetSupportTicketComments> = {
  nameSpace: "reactor-macros",
  name: "getSupportTicketComments",
  version: "1.0.0",
  component: GetSupportTicketComments,
  description: "Read the conversation on a support ticket: oldest comment first, with author names, timestamps, reply relationships and comment attachments",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "comments", "conversation", "thread", "read"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getSupportTicketComments",
        description: "Read a support ticket's comments, oldest first. Accepts the ticket ObjectId or its human-readable reference. Every comment carries its author's name, its timestamp, the id of the comment it replies to (parentId) and the files attached to it.",
        parameters: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The support ticket's ObjectId (24 char hex) or its human-readable reference number",
            },
            includeReplies: {
              type: "boolean",
              description: "Include replies (comments that answer another comment). Defaults to true; set false for top-level notes only",
            },
          },
          required: ["ticketId"],
        },
      },
    },
  ],
};

/**
 * Lists the files attached to a support ticket.
 *
 * Returns resolved metadata (id, filename/alias, url, size, mimetype) so the
 * agent can name a file in a reply, fetch it, or reference its id.
 */
export const GetSupportTicketAttachments: Macro<SupportMacroResult, GetSupportTicketAttachmentsProps> = async (
  props: GetSupportTicketAttachmentsProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { ticketId: identifier } = props || ({} as GetSupportTicketAttachmentsProps);

  if (!identifier || identifier.trim().length === 0) {
    return supportMacroFailure("getSupportTicketAttachments", props, state, startTime, "No ticket ID provided");
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return supportMacroFailure(
      "getSupportTicketAttachments",
      props,
      state,
      startTime,
      "ReactorySupportService not found in execution context"
    );
  }

  const service = (supportService as unknown) as SupportTicketReadService;
  const candidate = identifier.trim();

  try {
    const resolved = await resolveSupportTicket(service, candidate);

    if (!resolved) {
      return supportMacroFailure(
        "getSupportTicketAttachments",
        props,
        state,
        startTime,
        `Ticket with ${isObjectIdString(candidate) ? "ID" : "reference"} ${candidate} not found`,
        { lookup: isObjectIdString(candidate) ? "id" : "reference" }
      );
    }

    const rawDocuments = await service.listTicketDocuments(resolved.ticketId);
    const attachments = (Array.isArray(rawDocuments) ? rawDocuments : []).map(toAttachmentView);
    const reference = supportTicketReferenceOf(resolved.ticket);

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTicketAttachments = { ticketId: resolved.ticketId, attachments };

    return {
      success: true,
      data: {
        ticketId: resolved.ticketId,
        reference,
        lookup: resolved.lookup,
        total: attachments.length,
        attachments,
      },
      tool: "getSupportTicketAttachments",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        lookup: resolved.lookup,
        total: attachments.length,
      },
      instructions: `
## Ticket Attachments — ${reference || resolved.ticketId}

- **Ticket ID**: ${resolved.ticketId}
- **Reference**: ${reference || "N/A"}
- **Attachments**: ${attachments.length}

${attachments.length === 0 ? "This ticket has no attachments." : formatAttachmentList(attachments)}
      `,
    };
  } catch (error) {
    logger.error(`Error in GetSupportTicketAttachments macro for ticket ${identifier}:`, error);
    return supportMacroFailure(
      "getSupportTicketAttachments",
      props,
      state,
      startTime,
      `Error listing support ticket attachments: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

export const GetSupportTicketAttachmentsRegistry: MacroComponentDefinition<typeof GetSupportTicketAttachments> = {
  nameSpace: "reactor-macros",
  name: "getSupportTicketAttachments",
  version: "1.0.0",
  component: GetSupportTicketAttachments,
  description: "List the files attached to a support ticket with resolved id, filename, url, size and MIME type",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "attachments", "documents", "files", "read"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getSupportTicketAttachments",
        description: "List a support ticket's attachments with resolved metadata (id, filename/alias, url, size, mimetype). Use the returned id with addSupportTicketComment to reference a file, or fetch the url.",
        parameters: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The support ticket's ObjectId (24 char hex) or its human-readable reference number",
            },
          },
          required: ["ticketId"],
        },
      },
    },
  ],
};

/**
 * Attaches an existing Reactory file to a support ticket.
 *
 * Two input modes:
 *  - `fileId` attaches a file that is already in the Reactory file store;
 *  - `path` reads a file from the agent workspace, uploads it through
 *    `core.ReactoryFileService@1.0.0`, then attaches the uploaded file.
 *
 * The workspace root for `path` mode comes from per-execution state
 * (`state.vars.worktreePath`, then `REACTOR_AGENT_WORKSPACE`) and never from
 * `process.cwd()`; with neither configured, `path` mode fails closed without
 * reading anything. `fileId` mode is unaffected and is the recommended mode
 * when the caller already has an uploaded file.
 *
 * `path` is sandboxed to the workspace root, traversal and symlink escapes are
 * rejected, and uploads are capped at `MAX_ATTACHMENT_BYTES` (10 MB). The agent
 * must not be able to attach arbitrary host files, so nothing outside the
 * worktree is ever read.
 *
 * Returns the ticket's attachment list after the attach so the caller can
 * confirm the file landed.
 */
export const AttachSupportTicketFile: Macro<SupportMacroResult, AttachSupportTicketFileProps> = async (
  props: AttachSupportTicketFileProps,
  state: ChatState
): Promise<SupportMacroResult> => {
  const startTime = Date.now();
  const { ticketId: identifier, path: inputPath, fileId: inputFileId, name } = props || ({} as AttachSupportTicketFileProps);

  if (!identifier || identifier.trim().length === 0) {
    return supportMacroFailure("attachSupportTicketFile", props, state, startTime, "No ticket ID provided");
  }

  const hasPath = typeof inputPath === "string" && inputPath.trim().length > 0;
  const hasFileId = typeof inputFileId === "string" && inputFileId.trim().length > 0;

  if (hasPath === hasFileId) {
    return supportMacroFailure(
      "attachSupportTicketFile",
      props,
      state,
      startTime,
      "Provide either 'fileId' (an already-uploaded Reactory file) or 'path' (a file inside the agent workspace) — not both, and not neither"
    );
  }

  const supportService = state.context?.getService<Reactory.Service.TReactorySupportService>(
    "core.ReactorySupportService@1.0.0"
  );

  if (!supportService) {
    return supportMacroFailure(
      "attachSupportTicketFile",
      props,
      state,
      startTime,
      "ReactorySupportService not found in execution context"
    );
  }

  const service = (supportService as unknown) as SupportTicketReadService;
  const candidate = identifier.trim();
  let uploaded: { fileId: string; filename: string | null; size: number | null; mimetype: string | null } | null = null;

  try {
    // Vet the caller's file input before anything is read or looked up: a
    // hostile path or a malformed id must not cost a ticket lookup, and a ticket
    // that turns out not to exist must not leave an orphaned upload behind.
    // `hasPath` mode takes its sandbox root from per-execution state only and
    // fails closed when none is configured. Both sources are read here, at the
    // call site, so the helpers below stay pure and take the root as an argument.
    const resolvedFile = hasPath
      ? resolveWorkspaceFile(
          inputPath,
          attachmentWorkspaceRoot([
            (state?.vars as any)?.worktreePath,
            process.env.REACTOR_AGENT_WORKSPACE,
          ])
        )
      : null;

    if (resolvedFile && !resolvedFile.file) {
      return supportMacroFailure(
        "attachSupportTicketFile",
        props,
        state,
        startTime,
        resolvedFile.error
      );
    }

    if (hasFileId && !isObjectIdString(inputFileId.trim())) {
      return supportMacroFailure(
        "attachSupportTicketFile",
        props,
        state,
        startTime,
        `fileId '${inputFileId.trim()}' is not a Reactory file id (expected a 24 character hex ObjectId)`
      );
    }

    const resolved = await resolveSupportTicket(service, candidate);

    if (!resolved) {
      return supportMacroFailure(
        "attachSupportTicketFile",
        props,
        state,
        startTime,
        `Ticket with ${isObjectIdString(candidate) ? "ID" : "reference"} ${candidate} not found`,
        { lookup: isObjectIdString(candidate) ? "id" : "reference" }
      );
    }

    let attachFileId: string;

    if (hasFileId) {
      attachFileId = inputFileId.trim();
    } else {
      const fileService = state.context?.getService<Reactory.Service.IReactoryFileService>(
        "core.ReactoryFileService@1.0.0"
      );

      if (!fileService) {
        return supportMacroFailure(
          "attachSupportTicketFile",
          props,
          state,
          startTime,
          "ReactoryFileService not found in execution context"
        );
      }

      // Vetted above: `path` mode returned when the file could not be read, so
      // this is present. Asserted rather than re-checked so the upload path
      // carries no branch that can never be taken.
      const workspaceFile = (resolvedFile as { file: ResolvedWorkspaceFile }).file;

      const filename = pathModule.basename(workspaceFile.absolutePath);
      const mimetype = mimeTypeForPath(workspaceFile.absolutePath);

      // The file service expects the graphql-upload shape: a promise-like whose
      // `createReadStream()` yields the bytes. A plain object satisfies it.
      const upload = await fileService.uploadFile({
        file: {
          createReadStream: () => createReadStream(workspaceFile.absolutePath),
          filename,
          mimetype,
          encoding: "binary",
        },
        rename: false,
        catalog: true,
        isUserSpecific: true,
        virtualPath: "support/attachments",
        filename: typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined,
      });

      const uploadedId = (upload as any)?._id ?? (upload as any)?.id;
      if (!uploadedId) {
        return supportMacroFailure(
          "attachSupportTicketFile",
          props,
          state,
          startTime,
          "ReactoryFileService did not return a file id for the upload"
        );
      }

      uploaded = {
        fileId: String(uploadedId),
        filename: (upload as any)?.filename ?? filename,
        size: typeof (upload as any)?.size === "number" ? (upload as any).size : workspaceFile.size,
        mimetype: (upload as any)?.mimetype ?? mimetype,
      };
      attachFileId = uploaded.fileId;
    }

    await service.attachDocument(resolved.ticketId, [attachFileId]);

    const rawDocuments = await service.listTicketDocuments(resolved.ticketId);
    const attachments = (Array.isArray(rawDocuments) ? rawDocuments : []).map(toAttachmentView);
    const reference = supportTicketReferenceOf(resolved.ticket);

    // `attachDocument` silently ignores ids that do not resolve to a file
    // (`if (file && ...)`), so a resolved promise is not proof that anything was
    // attached. Verify the invariant against the ticket's own document list:
    // the id we asked for must be there now. Without this the macro could report
    // success for a typo'd or deleted file id, which the caller cannot check.
    if (!attachments.some((attachment) => attachment.id === attachFileId)) {
      const detail = hasFileId
        ? `File ${attachFileId} was not found in the Reactory file store, so it was not attached to ticket ${resolved.ticketId}.`
        : `Uploaded file ${attachFileId} did not appear on ticket ${resolved.ticketId} after attaching.`;

      logger.warn(
        `AttachSupportTicketFile macro could not confirm file ${attachFileId} on ticket ${resolved.ticketId} by user: ${state.user?.id}`
      );

      return supportMacroFailure("attachSupportTicketFile", props, state, startTime, detail, {
        lookup: resolved.lookup,
        attachedFileId: attachFileId,
        ...(uploaded ? { uploadedFileId: uploaded.fileId } : {}),
      });
    }

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSupportTicketAttachments = { ticketId: resolved.ticketId, attachments };

    logger.info(
      `AttachSupportTicketFile macro attached file ${attachFileId} to ticket ${resolved.ticketId} (${uploaded ? "uploaded from path" : "existing file"}) by user: ${state.user?.id}`
    );

    return {
      success: true,
      data: {
        ticketId: resolved.ticketId,
        reference,
        lookup: resolved.lookup,
        attached: {
          fileId: attachFileId,
          mode: hasFileId ? "fileId" : "path",
          filename: uploaded?.filename ?? null,
          size: uploaded?.size ?? null,
          mimetype: uploaded?.mimetype ?? null,
        },
        total: attachments.length,
        attachments,
      },
      tool: "attachSupportTicketFile",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        lookup: resolved.lookup,
        total: attachments.length,
      },
      instructions: `
## File Attached to Ticket ${reference || resolved.ticketId}

- **Ticket ID**: ${resolved.ticketId}
- **File ID**: ${attachFileId}
- **Source**: ${hasFileId ? "existing Reactory file" : "uploaded from workspace path"}
${uploaded?.filename ? `- **Filename**: ${uploaded.filename}\n` : ""}${uploaded?.size !== null && uploaded?.size !== undefined ? `- **Size**: ${uploaded.size} bytes\n` : ""}${uploaded?.mimetype ? `- **MIME Type**: ${uploaded.mimetype}\n` : ""}- **Attachments on ticket**: ${attachments.length}

${formatAttachmentList(attachments)}
      `,
    };
  } catch (error) {
    logger.error(`Error in AttachSupportTicketFile macro for ticket ${identifier}:`, error);
    return supportMacroFailure(
      "attachSupportTicketFile",
      props,
      state,
      startTime,
      `Error attaching file to support ticket: ${error instanceof Error ? error.message : "Unknown error"}`,
      uploaded ? { uploadedFileId: uploaded.fileId } : {}
    );
  }
};

export const AttachSupportTicketFileRegistry: MacroComponentDefinition<typeof AttachSupportTicketFile> = {
  nameSpace: "reactor-macros",
  name: "attachSupportTicketFile",
  version: "1.0.0",
  component: AttachSupportTicketFile,
  description: "Attach an existing Reactory file, or a workspace file uploaded on the fly, to a support ticket",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "attachment", "upload", "file", "attach"],
  tools: [
    {
      type: "function",
      function: {
        name: "attachSupportTicketFile",
        description: "Attach a file to a support ticket. Pass either 'fileId' (an already-uploaded Reactory file id) or 'path' (a readable file inside the agent worktree, which is uploaded first — capped at 10 MB). Path mode requires a configured agent workspace and fails closed without one; absolute host paths, paths outside the worktree, '..' traversal and symlink escapes are rejected. Fails if the file id does not appear on the ticket afterwards. Returns the ticket's attachment list.",
        parameters: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The support ticket's ObjectId (24 char hex) or its human-readable reference number",
            },
            fileId: {
              type: "string",
              description: "Id of an already-uploaded Reactory file to attach",
            },
            path: {
              type: "string",
              description: "Path to a file inside the agent worktree (relative to it, or absolute within it). It is uploaded to the Reactory file store and then attached. Maximum 10 MB. Requires a configured agent workspace; path mode fails closed without one.",
            },
            name: {
              type: "string",
              description: "Optional display name to store the uploaded file under (path mode only)",
            },
          },
          required: ["ticketId"],
        },
      },
    },
  ],
};