import {
  GetSupportTicket,
  GetSupportTicketRegistry,
  ListSupportTickets,
  ListSupportTicketsRegistry,
  CreateSupportTicket,
  CreateSupportTicketRegistry,
  UpdateSupportTicket,
  UpdateSupportTicketRegistry,
  AddSupportTicketComment,
  AddSupportTicketCommentRegistry,
  GetSupportTicketComments,
  GetSupportTicketCommentsRegistry,
  GetSupportTicketAttachments,
  GetSupportTicketAttachmentsRegistry,
  AttachSupportTicketFile,
  AttachSupportTicketFileRegistry,
} from "./macro";

export * from "./types";
export * from "./macro";

export const SupportMacros = [
  GetSupportTicketRegistry,
  ListSupportTicketsRegistry,
  CreateSupportTicketRegistry,
  UpdateSupportTicketRegistry,
  AddSupportTicketCommentRegistry,
  GetSupportTicketCommentsRegistry,
  GetSupportTicketAttachmentsRegistry,
  AttachSupportTicketFileRegistry,
];

export default SupportMacros;
