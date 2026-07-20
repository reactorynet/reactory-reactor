const AgentGitCommitSchema = {
  type: "object",
  title: "Agent Git Commit",
  properties: {
    workdir: {
      type: "string",
      title: "Working Directory",
      description: "Absolute path of the git repository root. Defaults to the server process cwd.",
    },
    personaId: {
      type: "string",
      title: "Persona ID",
      default: "GitGuardian",
      description: "Reactor AI persona to consult for the commit decision.",
    },
    hint: {
      type: "string",
      title: "Hint",
      description: "Optional context hint for the agent (e.g. 'added unit tests for the payment module').",
    },
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "Resume an existing agent session. Useful for engine retries so the same conversation is reused.",
    },
  },
};

export default AgentGitCommitSchema;
