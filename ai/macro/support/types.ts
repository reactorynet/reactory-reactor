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
