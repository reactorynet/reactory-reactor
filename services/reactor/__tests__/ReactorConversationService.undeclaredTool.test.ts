import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

/**
 * The AUTO-loop branch that decides what to do with a tool call the conversation
 * does not declare.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * Both ways of getting this wrong are silent, and they fail in opposite
 * directions:
 *
 *  - **Refusing a tool the browser can run** turns a working capability into a
 *    macro error. That is the original `chart` failure: no server-side macro
 *    exists for it, so it is only ever known to the client, and a session that
 *    never recorded it made the model's call die with `Macro chart not found in
 *    chat session` — failing the turn, and (because the failure path re-resolves
 *    the provider) risking the follow-up being routed to the default
 *    OpenAI-compatible endpoint.
 *
 *  - **Forwarding a tool the browser cannot run** leaves a `tool_call` that
 *    nothing will ever answer. Providers reject or mis-handle a tool call with no
 *    result, so the transcript stays permanently malformed.
 *
 * The decision was previously inline in the AUTO loop, inside a ~9,000-line
 * method, where it could only be exercised by standing up a provider, a transport
 * and a database. It is now `classifyUndeclaredToolCall` — a pure function of
 * (toolName, conversation, registry) — so the policy below is asserted directly.
 *
 * SCOPE NOTE: these tests cover the *decision*. That the AUTO loop consults it
 * (rather than re-deriving the policy inline) is verified by the extraction
 * itself: the loop now holds no classification logic and branches on
 * `verdict.forwardToClient`.
 */
describe("ReactorConversationService - classifyUndeclaredToolCall", () => {
  let service: any;

  /** Registry stub: `getMacro` returns whatever is registered for a name. */
  const withRegistry = (entries: Record<string, any>) => {
    service.macroService = {
      getMacro: jest.fn((name: string) => entries[name] ?? null),
    };
  };

  beforeEach(() => {
    service = Object.create(ReactorConversationService.prototype);
    service.sessionLog = jest.fn();
    service.macroService = { getMacro: jest.fn(() => null) };
  });

  describe("the registry vouches for a client macro", () => {
    it("forwards rather than refuses", () => {
      // The case that fixes the reported bug: `chart` has no server-side
      // definition, so it exists only in the client's registry. Forwarding is
      // strictly better than failing the turn.
      withRegistry({ chart: { name: "ChartMacro", alias: "chart", runat: "client" } });

      const verdict = service.classifyUndeclaredToolCall("chart", { tools: [], macros: [] });

      expect(verdict.forwardToClient).toBe(true);
      expect(verdict.message).toBeNull();
      expect(verdict.reason).toBeNull();
    });

    it("forwards even when the session recorded nothing at all", () => {
      // The stale-session case `syncClientCapabilities` repairs. The registry is
      // the only evidence available, and it is enough.
      withRegistry({ d3: { name: "D3Macro", alias: "d3", runat: "client" } });

      const verdict = service.classifyUndeclaredToolCall("d3", {
        tools: [],
        macros: [],
      });

      expect(verdict.forwardToClient).toBe(true);
    });

    it("forwards a client macro declared by its own name rather than its alias", () => {
      withRegistry({ ChartMacro: { name: "ChartMacro", runat: "client" } });

      const verdict = service.classifyUndeclaredToolCall("ChartMacro", {});
      expect(verdict.forwardToClient).toBe(true);
    });
  });

  describe("the registry knows the tool but owns it server-side", () => {
    it("does NOT forward a server-routed tool", () => {
      // Critical: a server tool must never be handed to a browser, which could
      // never produce a result and would leave the turn waiting forever.
      withRegistry({ shell: { name: "shell", runat: "server" } });

      const verdict = service.classifyUndeclaredToolCall("shell", { tools: [], macros: [] });

      expect(verdict.forwardToClient).toBe(false);
      expect(verdict.reason).toBe("unknown");
    });

    it("treats a registry entry with no `runat` as server-owned", () => {
      // `runat` defaults to server everywhere else it is read (`getToolRunAt`
      // returns `tool.runat || "server"`), so an entry that omits it must not be
      // forwarded. This is the subtle one: the tool IS in the registry, which
      // makes it tempting to forward.
      withRegistry({ mystery: { name: "mystery" } });

      const verdict = service.classifyUndeclaredToolCall("mystery", {});

      expect(verdict.forwardToClient).toBe(false);
      expect(verdict.reason).toBe("unknown");
    });

    it("treats an explicit non-client runat value as server-owned", () => {
      withRegistry({ weirdsrv: { name: "weirdsrv", runat: "worker" } });

      const verdict = service.classifyUndeclaredToolCall("weirdsrv", {});
      expect(verdict.forwardToClient).toBe(false);
    });
  });

  describe("the session knows the tool is client-routed but cannot reach it", () => {
    it("refuses with the actionable message when a client macro declares it", () => {
      // A tool that appears only inside a client macro's own `tools` list is not
      // in `knownToolNames` (which walks macros' alias/name, not their tools), so
      // it reaches this branch — and the browser genuinely could run it, so the
      // model must be told how to unblock itself.
      service.macroService = { getMacro: jest.fn(() => null) };

      const verdict = service.classifyUndeclaredToolCall("chart", {
        tools: [],
        macros: [
          {
            name: "ChartMacro",
            alias: "chart",
            runat: "client",
            tools: [{ type: "function", function: { name: "chart" } }],
          },
        ],
      });

      expect(verdict.forwardToClient).toBe(false);
      expect(verdict.reason).toBe("client-unavailable");
      expect(verdict.message).toMatch(/client-side tool/i);
      expect(verdict.message).toMatch(/re-open the conversation/i);
    });

    it("refuses with the actionable message when a session tool is client-routed", () => {
      const verdict = service.classifyUndeclaredToolCall("image", {
        tools: [{ type: "function", runat: "client", function: { name: "image" } }],
        macros: [],
      });

      expect(verdict.reason).toBe("client-unavailable");
    });

    it("prefers the registry's verdict over the session's", () => {
      // When the registry says client, the tool is forwarded even though the
      // session also declares it client — forwarding is the better outcome and
      // the registry is authoritative about what the server can run.
      withRegistry({ chart: { alias: "chart", runat: "client" } });

      const verdict = service.classifyUndeclaredToolCall("chart", {
        tools: [{ type: "function", runat: "client", function: { name: "chart" } }],
        macros: [],
      });

      expect(verdict.forwardToClient).toBe(true);
    });
  });

  describe("neither the registry nor the session knows the tool", () => {
    it("refuses as unknown and tells the model not to retry", () => {
      const verdict = service.classifyUndeclaredToolCall("hallucinated_tool", {
        tools: [],
        macros: [],
      });

      expect(verdict.forwardToClient).toBe(false);
      expect(verdict.reason).toBe("unknown");
      expect(verdict.message).toMatch(/not available in this conversation/i);
      expect(verdict.message).toMatch(/do not retry/i);
    });

    it("never returns an empty message on a refusal", () => {
      // The refusal is delivered to the model as the tool result. An empty one
      // would be indistinguishable from a tool that returned nothing, so the
      // model would have no way to know it must stop retrying.
      const verdict = service.classifyUndeclaredToolCall("nope", {});

      expect(verdict.message).toBeTruthy();
      expect((verdict.message as string).length).toBeGreaterThan(20);
    });
  });

  describe("registry lookup failures", () => {
    it("fails closed to a refusal when getMacro throws", () => {
      // Failing *open* (forwarding) is the tempting choice and the wrong one: an
      // unverifiable forward can leave a dangling tool call if the browser cannot
      // run it, whereas a refusal gives the model actionable feedback and the turn
      // survives.
      service.macroService = {
        getMacro: jest.fn(() => {
          throw new Error("macro registry unavailable");
        }),
      };

      const verdict = service.classifyUndeclaredToolCall("chart", {});

      expect(verdict.forwardToClient).toBe(false);
      expect(verdict.reason).toBe("unknown");
    });

    it("fails closed when the macro service is absent entirely", () => {
      service.macroService = undefined;

      const verdict = service.classifyUndeclaredToolCall("chart", {});

      expect(verdict.forwardToClient).toBe(false);
    });

    it("fails closed when getMacro is not a function", () => {
      service.macroService = { getMacro: "not-a-function" };

      const verdict = service.classifyUndeclaredToolCall("chart", {});

      expect(verdict.forwardToClient).toBe(false);
    });
  });

  describe("tolerance of malformed conversations", () => {
    it("handles a conversation with no tools or macros arrays", () => {
      const verdict = service.classifyUndeclaredToolCall("chart", {});
      expect(verdict.reason).toBe("unknown");
    });

    it("handles null entries inside arrays", () => {
      const verdict = service.classifyUndeclaredToolCall("chart", {
        tools: [null, undefined],
        macros: [null, { name: "x", runat: "server" }],
      });

      expect(verdict.forwardToClient).toBe(false);
    });

    it("handles a null conversation", () => {
      const verdict = service.classifyUndeclaredToolCall("chart", null);
      expect(verdict.forwardToClient).toBe(false);
    });
  });
});
