import {
  GetSupportTicket,
  ListSupportTickets,
  CreateSupportTicket,
  UpdateSupportTicket,
  AddSupportTicketComment,
  GetSupportTicketComments,
  GetSupportTicketAttachments,
  AttachSupportTicketFile,
} from "../macro";
import { createMockState } from "../../runtime/__tests__/support/mockState";

/**
 * A service *lookup* that throws must produce a tool result, not a rejected promise.
 *
 * THE BUG
 * -------
 * Every macro in `ai/macro/support/macro.ts` resolved its service like this:
 *
 *     const supportService = state.context?.getService<T>("core.ReactorySupportService@1.0.0");
 *     if (!supportService) { return { success: false, ... } }
 *     try { ...actual work... } catch (error) { return { success: false, ... } }
 *
 * The `getService` call sat above the `try`. It looks like a property read and is
 * not one: it is a call into the service registry, and it can throw — an
 * unresolvable dependency, a registry/decorator failure, or a context that exists
 * but is broken. When it did, the macro rejected instead of returning its
 * `{ success: false, error }` envelope, so the caller (`executeMacro`'s per-tool
 * catch in the AUTO loop) could only report a generic macro failure and the model
 * got a failed *turn* where a failed *tool result* belonged.
 *
 * `ListSupportTickets` is the macro named in ticket
 * REACTORY-302016408/20261104/2715764250, whose two `listSupportTickets` calls were
 * never dispatched at all. This suite covers it and its seven siblings, because the
 * shape was identical in all eight — a pattern this uniform is only half fixed if
 * the next one copied is left broken.
 *
 * WHAT IS ASSERTED
 * ----------------
 * For each macro: the lookup is actually reached (so the case cannot pass vacuously
 * by returning an earlier validation error), the macro resolves rather than
 * rejecting, the envelope is `success: false`, and the message carries the
 * resolution failure so the operator can tell "the service is broken" from "the
 * ticket does not exist".
 */
const OBJECT_ID = "507f1f77bcf86cd799439011";
const RESOLUTION_FAILURE = "service registry unavailable (test)";

describe("Support macros - a throwing getService becomes a failure envelope", () => {
  let state: any;

  beforeEach(() => {
    state = createMockState({
      context: {
        getService: jest.fn(() => {
          throw new Error(RESOLUTION_FAILURE);
        }),
        user: { _id: "user-123" },
      } as any,
      user: { id: "user-123" },
      vars: {},
    });
  });

  /**
   * Every macro, with the smallest props that get past its own argument validation
   * and reach the service lookup.
   */
  const cases: Array<{ name: string; macro: any; props: any }> = [
    { name: "GetSupportTicket", macro: GetSupportTicket, props: { id: OBJECT_ID } },
    { name: "ListSupportTickets", macro: ListSupportTickets, props: {} },
    {
      name: "CreateSupportTicket",
      macro: CreateSupportTicket,
      props: { request: "Printer on fire", description: "Smoke from the top tray" },
    },
    {
      name: "UpdateSupportTicket",
      macro: UpdateSupportTicket,
      props: { ticketId: OBJECT_ID, status: "open" },
    },
    {
      name: "AddSupportTicketComment",
      macro: AddSupportTicketComment,
      props: { ticketId: OBJECT_ID, comment: "Looking into it" },
    },
    { name: "GetSupportTicketComments", macro: GetSupportTicketComments, props: { ticketId: OBJECT_ID } },
    { name: "GetSupportTicketAttachments", macro: GetSupportTicketAttachments, props: { ticketId: OBJECT_ID } },
    {
      name: "AttachSupportTicketFile",
      macro: AttachSupportTicketFile,
      props: { ticketId: OBJECT_ID, fileId: OBJECT_ID },
    },
  ];

  it.each(cases)("$name returns {success:false} instead of throwing", async ({ macro, props }) => {
    const result = await macro(props, state);

    // Reached the lookup — otherwise the assertions below would be satisfied by an
    // argument-validation early return and prove nothing about the fix.
    expect(state.context.getService).toHaveBeenCalledWith("core.ReactorySupportService@1.0.0");

    expect(result.success).toBe(false);
    // The cause survives into the envelope: a resolution failure must not be
    // reported as a missing ticket or a generic macro error.
    expect(String(result.error)).toContain(RESOLUTION_FAILURE);
  });

  it("names the tool in the envelope so a batch of results stays attributable", async () => {
    const result = await ListSupportTickets({}, state);

    expect(result.tool).toBe("listSupportTickets");
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/^Error listing support tickets:/);
  });

  it("still reports a missing service distinctly from a failing one", async () => {
    // The `if (!supportService)` guard is deliberately kept: "the registry returned
    // nothing" is a different condition from "the registry threw", and the message
    // says which one happened.
    state.context.getService = jest.fn(() => null);

    const result = await ListSupportTickets({}, state);

    expect(result.success).toBe(false);
    expect(result.error).toBe("ReactorySupportService not found in execution context");
  });
});
