/**
 * Global keyboard shortcuts for ReactorTUI.
 * Returns a map of key combos to handler descriptions that
 * the main TUI wires up on the blessed screen instance.
 */

export interface KeyBinding {
  keys: string[];
  description: string;
  category: "navigation" | "chat" | "panels" | "voice" | "general";
}

/**
 * All keybindings — the main TUI reads this and binds each to
 * the appropriate handler on the blessed screen.
 */
export const KEY_BINDINGS: Record<string, KeyBinding> = {
  quit: {
    keys: ["C-q"],
    description: "Quit ReactorTUI",
    category: "general",
  },
  interrupt: {
    keys: ["C-c"],
    description: "Quit ReactorTUI",
    category: "general",
  },
  help: {
    keys: ["f1"],
    description: "Show help overlay",
    category: "general",
  },
  clearChat: {
    keys: ["C-l"],
    description: "Clear chat display",
    category: "chat",
  },
  newChat: {
    keys: ["C-n"],
    description: "Start new chat session",
    category: "chat",
  },
  toggleStreaming: {
    keys: ["C-s"],
    description: "Toggle SSE streaming mode",
    category: "chat",
  },
  togglePersonas: {
    keys: ["C-p"],
    description: "Toggle personas panel",
    category: "panels",
  },
  toggleTools: {
    keys: ["C-t"],
    description: "Toggle tools panel",
    category: "panels",
  },
  toggleHistory: {
    keys: ["C-h"],
    description: "Toggle chat history panel",
    category: "panels",
  },
  toggleFiles: {
    keys: ["C-f"],
    description: "Toggle files panel",
    category: "panels",
  },
  toggleDebug: {
    keys: ["C-d"],
    description: "Toggle debug panel (dev mode)",
    category: "panels",
  },
  toggleVoice: {
    keys: ["C-v"],
    description: "Toggle voice mode",
    category: "voice",
  },
  cyclePanels: {
    keys: ["tab"],
    description: "Cycle focus between panels",
    category: "navigation",
  },
  closePanel: {
    keys: ["escape"],
    description: "Close active side panel / cancel",
    category: "navigation",
  },
};

/**
 * Format keybindings into a human-readable help string for the help overlay.
 */
export function formatHelpText(): string {
  const categories: Record<string, KeyBinding[]> = {};
  for (const binding of Object.values(KEY_BINDINGS)) {
    if (!categories[binding.category]) categories[binding.category] = [];
    categories[binding.category].push(binding);
  }

  const lines: string[] = [
    "{bold}{cyan-fg}Keyboard Shortcuts{/cyan-fg}{/bold}",
    "",
  ];

  const categoryLabels: Record<string, string> = {
    general: "General",
    chat: "Chat",
    panels: "Panels",
    voice: "Voice",
    navigation: "Navigation",
  };

  for (const [cat, bindings] of Object.entries(categories)) {
    lines.push(`{bold}${categoryLabels[cat] || cat}{/bold}`);
    for (const b of bindings) {
      const keys = b.keys.map((k) => k.replace("C-", "Ctrl+")).join(", ");
      lines.push(`  {yellow-fg}${keys.padEnd(16)}{/yellow-fg} ${b.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format all slash commands into a help string.
 */
export function formatCommandHelp(): string {
  const lines: string[] = [
    "",
    "{bold}{cyan-fg}Slash Commands{/cyan-fg}{/bold}",
    "",
    "{bold}Chat{/bold}",
    "  {yellow-fg}/new              {/yellow-fg} Start new chat session",
    "  {yellow-fg}/load <id>        {/yellow-fg} Load a chat session by ID",
    "  {yellow-fg}/chats            {/yellow-fg} List recent chat sessions",
    "  {yellow-fg}/delete <id>      {/yellow-fg} Delete a chat session",
    "  {yellow-fg}/clear            {/yellow-fg} Clear the chat display",
    "",
    "{bold}Personas & Models{/bold}",
    "  {yellow-fg}/persona <name>   {/yellow-fg} Switch to a persona",
    "  {yellow-fg}/model <id>       {/yellow-fg} Switch AI model",
    "  {yellow-fg}/provider <id>    {/yellow-fg} Switch AI provider",
    "  {yellow-fg}/models           {/yellow-fg} List available models",
    "  {yellow-fg}/providers        {/yellow-fg} List available providers",
    "",
    "{bold}Tools & Macros{/bold}",
    "  {yellow-fg}/approve <mode>   {/yellow-fg} Set tool approval (auto|prompt|safe_auto)",
    "  {yellow-fg}/continue [N]     {/yellow-fg} Continue paused tool execution",
    "  {yellow-fg}/iterations <N>   {/yellow-fg} Set max tool iterations",
    "  {yellow-fg}/@macro(args)     {/yellow-fg} Execute a macro",
    "",
    "{bold}Files & Attachments{/bold}",
    "  {yellow-fg}/file <path>      {/yellow-fg} Attach a file to the session",
    "  {yellow-fg}/img <path>       {/yellow-fg} Send image to vision model",
    "",
    "{bold}Voice{/bold}",
    "  {yellow-fg}/voice            {/yellow-fg} Toggle voice mode",
    "  {yellow-fg}/voice off        {/yellow-fg} Disable voice mode",
    "",
    "{bold}Streaming & Network{/bold}",
    "  {yellow-fg}/stream on|off    {/yellow-fg} Toggle SSE streaming",
    "  {yellow-fg}/reconnect        {/yellow-fg} Retry connection",
    "",
    "{bold}Panels{/bold}",
    "  {yellow-fg}/personas         {/yellow-fg} Toggle personas panel",
    "  {yellow-fg}/tools            {/yellow-fg} Toggle tools panel",
    "  {yellow-fg}/history          {/yellow-fg} Toggle chat history panel",
    "  {yellow-fg}/files            {/yellow-fg} Toggle files panel",
    "  {yellow-fg}/todos            {/yellow-fg} Toggle todos panel",
    "  {yellow-fg}/debug            {/yellow-fg} Toggle debug panel",
    "",
    "  {yellow-fg}/help             {/yellow-fg} Show this help",
    "  {yellow-fg}/quit             {/yellow-fg} Quit ReactorTUI",
  ];

  return lines.join("\n");
}
