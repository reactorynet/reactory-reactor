import ReactorProviderService from "../ReactorProviderService";

const makeContext = () =>
  ({
    user: { _id: "u1" },
    partner: { auth_config: [] },
    hasRole: () => false,
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    getService: jest.fn(),
  } as any);

function makeService() {
  const svc: any = new ReactorProviderService({} as any, makeContext());
  // Isolate the capability logic from the on-disk registry.
  svc.getProvider = jest.fn(async (id: string) => {
    if (id === "openai") {
      return {
        id: "openai",
        models: [
          { id: "gpt-flag", capabilities: ["text-generation", "structured-output"] },
          { id: "gpt-plain", capabilities: ["text-generation", "reasoning"] },
          { id: "gpt-blocked", capabilities: ["text-generation", "no-structured-output"] },
        ],
      };
    }
    if (id === "anthropic") {
      return { id: "anthropic", models: [{ id: "claude-x", capabilities: ["reasoning"] }] };
    }
    return undefined;
  });
  return svc;
}

describe("ReactorProviderService.modelSupportsStructuredOutput", () => {
  let svc: any;
  beforeEach(() => {
    svc = makeService();
  });

  it("returns false for an unwired provider regardless of model", async () => {
    expect(await svc.modelSupportsStructuredOutput("amazon", "any")).toBe(false);
    expect(await svc.modelSupportsStructuredOutput("cohere", "any")).toBe(false);
    expect(await svc.modelSupportsStructuredOutput("deepseek", "any")).toBe(false);
  });

  it("returns true for a wired provider when no model id is given", async () => {
    expect(await svc.modelSupportsStructuredOutput("openai")).toBe(true);
  });

  it("normalizes provider id casing", async () => {
    expect(await svc.modelSupportsStructuredOutput("OpenAI", "gpt-flag")).toBe(true);
  });

  it("returns true for a model explicitly flagged structured-output", async () => {
    expect(await svc.modelSupportsStructuredOutput("openai", "gpt-flag")).toBe(true);
  });

  it("returns false for a model explicitly opted out with no-structured-output", async () => {
    expect(await svc.modelSupportsStructuredOutput("openai", "gpt-blocked")).toBe(false);
  });

  it("defaults to true for a wired provider model without an explicit flag", async () => {
    // Option B: wired providers default supported; the flag is opt-out, not opt-in.
    expect(await svc.modelSupportsStructuredOutput("openai", "gpt-plain")).toBe(true);
    expect(await svc.modelSupportsStructuredOutput("anthropic", "claude-x")).toBe(true);
  });

  it("defaults to true for a wired provider when the model is not in the registry", async () => {
    expect(await svc.modelSupportsStructuredOutput("openai", "unknown-model")).toBe(true);
    // wired alias not present in the registry map still defaults on
    expect(await svc.modelSupportsStructuredOutput("x-ai", "grok-x")).toBe(true);
  });

  it("defaults to true if the registry lookup throws", async () => {
    svc.getProvider = jest.fn(async () => {
      throw new Error("registry unavailable");
    });
    expect(await svc.modelSupportsStructuredOutput("openai", "gpt-plain")).toBe(true);
  });
});
