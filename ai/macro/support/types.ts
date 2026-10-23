import Reactory from "@reactorynet/reactory-core";

export interface GetSupportTicketProps {
  id: string;
}

export interface ListSupportTicketsProps {
  status?: string[];
  priority?: string[];
  searchString?: string;
  requestType?: string[];
  tags?: string[];
  assignedTo?: string[];
  showOverdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CreateSupportTicketProps {
  request: string;
  description: string;
  requestType?: string;
  priority?: string;
  formId?: string;
  meta?: any;
}

export interface UpdateSupportTicketProps {
  ticketId: string;
  status?: string;
  /** User ID of the assigned user account (ownership must always sit with a user account, not an agent ID) */
  assignTo?: string;
  priority?: string;
  comment?: string;
  request?: string;
  description?: string;
  tags?: string[];
}

export interface AddSupportTicketCommentProps {
  ticketId: string;
  comment: string;
  parentId?: string;
  attachmentIds?: string[];
}

/**
 * Read the conversation on a ticket.
 *
 * `ticketId` accepts the ObjectId or the human readable reference, exactly like
 * `getSupportTicket` does.
 */
export interface GetSupportTicketCommentsProps {
  ticketId: string;
  /** Include replies (comments that carry a `parentId`). Defaults to true. */
  includeReplies?: boolean;
}

/** List the files attached to a ticket. */
export interface GetSupportTicketAttachmentsProps {
  ticketId: string;
}

/**
 * Attach an existing Reactory file to a ticket.
 *
 * Exactly one of `fileId` (an already-uploaded file) or `path` (a readable file
 * inside the agent workspace, which is uploaded first) must be provided.
 */
export interface AttachSupportTicketFileProps {
  ticketId: string;
  /** Path to a file inside the agent workspace (relative, or absolute within it). */
  path?: string;
  /** Id of an already-uploaded Reactory file. */
  fileId?: string;
  /** Optional display name to store the uploaded file under (`path` mode only). */
  name?: string;
}

/** The author of a comment, resolved to something a reader can name. */
export interface SupportTicketCommentAuthorView {
  id: string | null;
  name: string | null;
}

/** A ticket or comment attachment, resolved to reader-facing metadata. */
export interface SupportTicketFileView {
  id: string;
  filename: string | null;
  alias: string | null;
  url: string | null;
  size: number | null;
  mimetype: string | null;
}

/** A comment as returned by `getSupportTicketComments`. */
export interface SupportTicketCommentView {
  id: string;
  text: string;
  createdAt: Date | null;
  author: SupportTicketCommentAuthorView;
  /** Set when the comment is a reply; the parent is the referenced comment. */
  parentId: string | null;
  attachments: SupportTicketFileView[];
}

export interface SupportMacroResult<T = any> {
  success: boolean;
  tool: string;
  params: any;
  data?: T;
  error?: string;
  metadata?: {
    executionTime?: number;
    timestamp?: Date;
    user?: string;
    [key: string]: any;
  };
  instructions?: string;
}
