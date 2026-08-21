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
} from "./macro";

export * from "./types";
export * from "./macro";

export const SupportMacros = [
  GetSupportTicketRegistry,
  ListSupportTicketsRegistry,
  CreateSupportTicketRegistry,
  UpdateSupportTicketRegistry,
  AddSupportTicketCommentRegistry,
];

export default SupportMacros;
