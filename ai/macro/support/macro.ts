import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import Reactory from "@reactorynet/reactory-core";
import {
  GetSupportTicketProps,
  ListSupportTicketsProps,
  CreateSupportTicketProps,
  UpdateSupportTicketProps,
  AddSupportTicketCommentProps,
  SupportMacroResult,
} from "./types";
import logger from "@reactory/server-core/logging";

/**
 * Retrieves a single support ticket by its ID
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
    const ticket = await supportService.getTicket(id.trim());
    const executionTime = Date.now() - startTime;

    if (!ticket) {
      return {
        success: false,
        error: `Ticket with ID ${id} not found`,
        tool: "getSupportTicket",
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
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
  description: "Retrieve a support ticket by ID with full details, comments, and assignee metadata",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "get", "inquiry"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getSupportTicket",
        description: "Retrieve a support ticket by ID with full details, comments, and metadata",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The unique ID of the support ticket",
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
  description: "Update a support ticket's status, assignment, priority, tags, or add an update comment",
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "support",
  tags: ["support", "ticket", "update", "assign", "delegate", "status"],
  tools: [
    {
      type: "function",
      function: {
        name: "updateSupportTicket",
        description: "Update an existing support ticket's status, assignee, priority, or details",
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
              description: "User ID or Agent ID of the assigned handler",
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
