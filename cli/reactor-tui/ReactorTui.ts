/**
 * ReactorTui — Main entry point and orchestrator for the blessed-based TUI.
 *
 * Responsibilities:
 *  - Creates the blessed layout
 *  - Initialises transport (direct or HTTP)
 *  - Loads personas via AIPersonaProvider
 *  - Wires keyboard shortcuts
 *  - Processes slash commands and chat input
 *  - Handles SSE streaming events (tokens, reasoning, tool calls, etc.)
 *  - Manages panels (personas, tools, history, files, help)
 */
import * as blessed from "neo-blessed";
import { ObjectId } from "mongodb";
import {
  TUIState,
  TUIMessage,
  IAIPersona,
  StreamingEventType,
  StreamingMode,
  ToolApprovalMode,
  TransportEvent,
  PanelName,
  DockSide,
  PanelState,
} from "./types";
import { DEFAULT_THEME, getTokenPressureColor, getMessageColor, getNetworkStatusIndicator, getStreamingIndicator, getVoiceIndicator } from "./theme";
import { KEY_BINDINGS, formatHelpText, formatCommandHelp } from "./keybindings";
import { createLayout, LayoutElements, adjustChatForSidePanel, adjustThinkingPanel } from "./layout";
import { createTransport, TransportFactoryOptions } from "./services";
import { ChatTransport } from "./types";
import { VoiceService } from "./voice";
import logger from "@reactory/server-core/logging";
import AIPersonaProvider from "@reactory/server-modules/reactory-reactor/services/reactor/AIPersonaProvider";
import fs from "fs";
import path from "path";

// ── Default initial state ──────────────────────────────────────────────

function createInitialState(): TUIState {
  return {
    sessionId: null,
    messages: [],
    persona: null,
    modelOverride: null,
    toolApprovalMode: ToolApprovalMode.AUTO,
    maxToolIterations: null,
    tokenCount: 0,
    maxTokens: null,
    tokenPressure: 0,
    isStreaming: false,
    streamingEnabled: true,
    currentStreamingContent: "",
    currentThinkingContent: "",
    networkStatus: "idle",
    reconnectAttempt: 0,
    vars: {},
    files: [],
    busy: false,
    tools: [],
    toolIterationLimitInfo: null,
    voiceModeActive: false,
  };
}

// ── Slash-command definitions ──────────────────────────────────────────

interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  handler: (args: string[]) => Promise<void>;
}

// ── Main TUI class ─────────────────────────────────────────────────────

export class ReactorTui {
  private context: Reactory.Server.IReactoryContext;
  private elements!: LayoutElements;
  private transport!: ChatTransport;
  private state: TUIState;
  private panel: PanelState = { open: false, dock: "right" };
  private activeSidePanel: PanelName | null = null;
  private personas: IAIPersona[] = [];
  private slashCommands: SlashCommand[] = [];
  private focusCycle: blessed.Widgets.BlessedElement[] = [];
  private focusIndex = 0;
  private chatScrollLocked = true;
  private voiceService: VoiceService | null = null;
  private _exitResolve: (() => void) | null = null;
  private _origConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
    info: typeof console.info;
  } | null = null;
  private _removedWinstonTransport: any = null;

  constructor(context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.state = createInitialState();
  }

  // ────────────────────────────────────────────────────────────────────
  // boot
  // ────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 0 — Pause the CLI readline so it stops competing for stdin
    const rl = (this.context as any).readline || (this.context as any).readLine;
    if (rl) {
      rl.pause();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("keypress");
    }

    // 1 — Redirect console.* methods to a log file so server debug output
    //     doesn't pollute the blessed screen. We must NOT touch process.stdout.write
    //     because blessed uses it directly to draw the TUI.
    const logDir = process.env.REACTORY_DATA
      ? path.join(process.env.REACTORY_DATA, "logging")
      : path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const tuiLogPath = path.join(logDir, "reactor-tui.log");
    const tuiLogStream = fs.createWriteStream(tuiLogPath, { flags: "a" });
    this._origConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      info: console.info,
    };
    const writeToLog = (...args: any[]) => {
      tuiLogStream.write(args.map(String).join(" ") + "\n");
    };
    console.log = writeToLog;
    console.warn = writeToLog;
    console.error = writeToLog;
    console.debug = writeToLog;
    console.info = writeToLog;

    // Also remove winston's Console transport so it doesn't write to stdout directly
    if (logger && logger.transports) {
      const consoleTransport = logger.transports.find(
        (t: any) => t.name === "console"
      );
      if (consoleTransport) {
        this._removedWinstonTransport = consoleTransport;
        logger.remove(consoleTransport);
      }
    }

    try {

    // 2 — Create the blessed layout
    this.elements = createLayout(DEFAULT_THEME);

    // 2 — Build transport
    this.transport = createTransport({
      context: this.context,
    } as TransportFactoryOptions);

    // 3 — Wire transport events
    this.transport.on("event", (evt: TransportEvent) =>
      this.handleTransportEvent(evt)
    );

    // 4 — Load personas
    await this.loadPersonas();

    // 4b — Initialize voice service
    this.voiceService = new VoiceService({ context: this.context });
    this.wireVoiceEvents();

    // 5 — Register slash commands
    this.registerSlashCommands();

    // 6 — Wire keybindings
    this.wireKeybindings();

    // 7 — Wire input submit
    this.wireInput();

    // 8 — Focus cycle
    this.focusCycle = [
      this.elements.inputPanel,
      this.elements.chatPanel as any,
    ];

    // 9 — Start first chat
    await this.startNewChat();

    // 10 — Focus input & render
    this.elements.inputPanel.focus();
    this.render();

    this.appendSystem(
      "Welcome to {bold}ReactorTUI{/bold}. " +
        "Type a message and press Enter to chat. " +
        "Press {bold}F1{/bold} for help, {bold}Ctrl+Q{/bold} to quit."
    );

    // Block until the user quits — keeps the CLI process alive
    return new Promise<void>((resolve) => {
      this._exitResolve = resolve;
    });

    } catch (startupErr: any) {
      // Restore console so the user can see the error
      if (this._origConsole) {
        console.log = this._origConsole.log;
        console.warn = this._origConsole.warn;
        console.error = this._origConsole.error;
        console.debug = this._origConsole.debug;
        console.info = this._origConsole.info;
      }
      if (this._removedWinstonTransport) {
        logger.add(this._removedWinstonTransport);
      }
      // Clean up blessed screen if it was created
      if (this.elements?.screen) {
        try { this.elements.screen.destroy(); } catch {}
      }
      console.error("[ReactorTui] Failed to start:", startupErr.message || startupErr);
      console.error(startupErr.stack || "");
      throw startupErr;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Transport event dispatcher
  // ────────────────────────────────────────────────────────────────────

  private handleTransportEvent(evt: TransportEvent): void {
    switch (evt.type) {
      case StreamingEventType.TOKEN:
        this.onToken(evt);
        break;
      case StreamingEventType.REASONING:
        this.onReasoning(evt);
        break;
      case StreamingEventType.TOOL_CALL:
        this.onToolCall(evt);
        break;
      case StreamingEventType.COMPLETE:
        this.onComplete(evt);
        break;
      case StreamingEventType.ERROR:
        this.onError(evt);
        break;
      case StreamingEventType.TOOL_ITERATION_LIMIT:
        this.onToolIterationLimit(evt);
        break;
      case StreamingEventType.RETRY:
        this.onRetry(evt);
        break;
      default:
        break;
    }
  }

  // ── Token streaming ────────────────────────────────────────

  private onToken(evt: TransportEvent): void {
    const { delta, content, isComplete } = evt.data;
    const chunk = delta || content || "";

    this.state.isStreaming = true;
    this.state.currentStreamingContent += chunk;

    // Append live token to the last line in chat
    this.updateStreamingDisplay();
  }

  private onReasoning(evt: TransportEvent): void {
    const { delta, content } = evt.data;
    const chunk = delta || content || "";

    this.state.currentThinkingContent += chunk;

    // Show thinking panel
    if (this.elements.thinkingPanel.hidden) {
      adjustThinkingPanel(this.elements, true, 6);
    }

    this.elements.thinkingPanel.setContent(
      this.state.currentThinkingContent
    );
    this.render();
  }

  private onToolCall(evt: TransportEvent): void {
    const { name, arguments: args, id, isComplete } = evt.data;

    if (isComplete) {
      this.appendChat(
        "tool",
        `{bold}⚙ Tool Call:{/bold} ${name}(${typeof args === "string" ? args : JSON.stringify(args)})`,
        { isActivity: true }
      );
    }
  }

  private onComplete(evt: TransportEvent): void {
    const { content, finishReason, thinking } = evt.data;

    // Finalize the streaming message
    const finalContent =
      content || this.state.currentStreamingContent || "";
    const finalThinking =
      thinking || this.state.currentThinkingContent || "";

    // Add complete assistant message
    this.addMessage({
      id: evt.messageId || new ObjectId().toHexString(),
      role: "assistant",
      content: finalContent,
      timestamp: new Date(),
      thinking: finalThinking || undefined,
    });

    // Reset streaming state
    this.state.isStreaming = false;
    this.state.busy = false;
    this.state.currentStreamingContent = "";
    this.state.currentThinkingContent = "";
    this.state.networkStatus = "connected";

    // Collapse thinking panel
    adjustThinkingPanel(this.elements, false);

    this.updateStatusBar();
    this.render();
  }

  private onError(evt: TransportEvent): void {
    const { message, code } = evt.data;
    this.appendChat("error", `{red-fg}⚠ Error${code ? ` [${code}]` : ""}: ${message}{/red-fg}`);
    this.state.isStreaming = false;
    this.state.busy = false;
    this.state.networkStatus = "error";
    this.updateStatusBar();
    this.render();
  }

  private onToolIterationLimit(evt: TransportEvent): void {
    const { iterationsCompleted, maxIterations, partialContent } = evt.data;

    this.state.toolIterationLimitInfo = {
      iterationsCompleted,
      maxIterations,
      partialContent: partialContent || "",
    };

    this.appendChat(
      "system",
      `{yellow-fg}⚠ Tool iteration limit reached (${iterationsCompleted}/${maxIterations}).{/yellow-fg}\n` +
        "  Use /continue to resume or /approve auto to change approval mode."
    );

    this.state.isStreaming = false;
    this.state.busy = false;
    this.updateStatusBar();
    this.render();
  }

  private onRetry(evt: TransportEvent): void {
    const { attempt, maxAttempts, retryAfterMs, reason } = evt.data;
    this.state.networkStatus = "reconnecting";
    this.state.reconnectAttempt = attempt;

    this.appendChat(
      "system",
      `{yellow-fg}↻ Retry ${attempt}/${maxAttempts}` +
        (reason ? ` — ${reason}` : "") +
        (retryAfterMs ? ` (${retryAfterMs}ms)` : "") +
        "{/yellow-fg}"
    );
    this.updateStatusBar();
  }

  // ────────────────────────────────────────────────────────────────────
  // Chat display helpers
  // ────────────────────────────────────────────────────────────────────

  private appendChat(
    role: TUIMessage["role"],
    content: string,
    extra?: Partial<TUIMessage>
  ): void {
    const color = getMessageColor(role);
    const prefix = this.rolePrefix(role);
    const line = `{${color}-fg}${prefix}{/${color}-fg} ${content}`;
    this.elements.chatPanel.log(line);
    if (this.chatScrollLocked) {
      this.elements.chatPanel.setScrollPerc(100);
    }
    this.render();
  }

  private appendSystem(content: string): void {
    this.appendChat("system", content);
  }

  private rolePrefix(role: string): string {
    switch (role) {
      case "user":
        return "[you]";
      case "assistant":
        return this.state.persona
          ? `[${this.state.persona.name}]`
          : "[assistant]";
      case "system":
        return "[sys]";
      case "tool":
        return "[tool]";
      case "error":
        return "[err]";
      default:
        return `[${role}]`;
    }
  }

  private addMessage(msg: TUIMessage): void {
    this.state.messages.push(msg);
    const color = getMessageColor(msg.role);
    const prefix = this.rolePrefix(msg.role);
    // For assistant messages, render the full content
    const line = `{${color}-fg}${prefix}{/${color}-fg} ${msg.content}`;
    this.elements.chatPanel.log(line);
    if (this.chatScrollLocked) {
      this.elements.chatPanel.setScrollPerc(100);
    }
    this.render();
  }

  /**
   * Update the streaming display — show partial content as it comes in.
   * We replace the last line in the chat panel with the growing content.
   */
  private updateStreamingDisplay(): void {
    // blessed.log doesn't support replacing last line natively,
    // so we log a carriage + the current streaming content.
    // A practical approach: clear and re-render the last assistant line.
    const lines = (this.elements.chatPanel as any).getLines() as string[];
    const prefix = this.rolePrefix("assistant");
    const color = getMessageColor("assistant");
    const streamLine = `{${color}-fg}${prefix}{/${color}-fg} ${this.state.currentStreamingContent}▊`;

    // If we already started streaming, replace the last line
    if (
      this.state.currentStreamingContent.length > 0 &&
      lines.length > 0 &&
      lines[lines.length - 1]?.includes("▊")
    ) {
      (this.elements.chatPanel as any).deleteLine(lines.length - 1);
    }

    this.elements.chatPanel.log(streamLine);
    if (this.chatScrollLocked) {
      this.elements.chatPanel.setScrollPerc(100);
    }
    this.render();
  }

  // ────────────────────────────────────────────────────────────────────
  // Status bar
  // ────────────────────────────────────────────────────────────────────

  private updateStatusBar(): void {
    const personaName = this.state.persona?.name || "No persona";
    const tokenStr = this.state.maxTokens
      ? `${this.state.tokenCount}/${this.state.maxTokens}`
      : `${this.state.tokenCount}/—`;
    const pressureColor = getTokenPressureColor(this.state.tokenPressure);
    const network = getNetworkStatusIndicator(
      this.state.networkStatus,
      this.state.reconnectAttempt
    );
    const stream = getStreamingIndicator(this.state.streamingEnabled);
    const voice = getVoiceIndicator(this.state.voiceModeActive);
    const busyStr = this.state.busy ? "{yellow-fg}⟳{/yellow-fg}" : "";
    const approval =
      this.state.toolApprovalMode !== ToolApprovalMode.AUTO
        ? ` │ 🛡${this.state.toolApprovalMode}`
        : "";

    this.elements.statusBar.setContent(
      ` {bold}ReactorTUI{/bold} │ ${personaName} │ ` +
        `{${pressureColor}-fg}Tokens: ${tokenStr}{/${pressureColor}-fg}` +
        `${approval} │ ${network} │ ${stream} ${voice} ${busyStr}`
    );
    this.render();
  }

  // ────────────────────────────────────────────────────────────────────
  // Input handling
  // ────────────────────────────────────────────────────────────────────

  private wireInput(): void {
    this.elements.inputPanel.key("enter", () => {
      const text = this.elements.inputPanel.getValue().trim();
      if (!text) return;
      this.elements.inputPanel.clearValue();
      this.render();

      this.handleInput(text);
    });
  }

  private async handleInput(text: string): Promise<void> {
    // Slash command?
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const cmdName = parts[0].toLowerCase();
      const args = parts.slice(1);

      const cmd = this.slashCommands.find(
        (c) => c.name === cmdName || c.aliases.includes(cmdName)
      );
      if (cmd) {
        try {
          await cmd.handler(args);
        } catch (err: any) {
          this.appendChat("error", `{red-fg}Command error: ${err.message}{/red-fg}`);
        }
        return;
      }

      this.appendChat("error", `Unknown command: /${cmdName}. Type /help for commands.`);
      return;
    }

    // Normal chat message
    await this.sendChatMessage(text);
  }

  // ────────────────────────────────────────────────────────────────────
  // Send chat message
  // ────────────────────────────────────────────────────────────────────

  private async sendChatMessage(text: string): Promise<void> {
    if (this.state.busy) {
      this.appendChat("system", "{yellow-fg}Please wait — still processing…{/yellow-fg}");
      return;
    }

    if (!this.state.sessionId) {
      await this.startNewChat();
    }

    if (!this.state.sessionId) {
      this.appendChat("error", "{red-fg}Could not establish a chat session.{/red-fg}");
      return;
    }

    // Add user message to display
    this.addMessage({
      id: new ObjectId().toHexString(),
      role: "user",
      content: text,
      timestamp: new Date(),
    });

    this.state.busy = true;
    this.state.networkStatus = "connected";
    this.state.currentStreamingContent = "";
    this.state.currentThinkingContent = "";
    this.updateStatusBar();

    try {
      const result = await this.transport.sendMessage(
        text,
        this.state.sessionId!,
        {
          streamingMode: this.state.streamingEnabled
            ? StreamingMode.SSE
            : StreamingMode.NONE,
        }
      );

      // sendMessage may return a new SSE init response (with sessionId) if re-initialization was needed
      const effectiveSessionId = result?.sessionId || this.state.sessionId;
      if (effectiveSessionId && effectiveSessionId !== this.state.sessionId) {
        this.state.sessionId = effectiveSessionId;
      }

      // For direct transport with SSE, set up the streaming listener
      if (
        this.transport.mode === "direct" &&
        this.state.streamingEnabled &&
        (this.transport as any).setupStreamingListener &&
        this.state.sessionId
      ) {
        await (this.transport as any).setupStreamingListener(
          this.state.sessionId
        );
      }

      // If non-streaming result came back directly (no SSE)
      if (!this.state.streamingEnabled && result) {
        // The transport will have emitted a COMPLETE event
      }
    } catch (err: any) {
      this.state.busy = false;
      this.state.networkStatus = "error";
      this.appendChat("error", `{red-fg}Send failed: ${err.message}{/red-fg}`);
      this.updateStatusBar();
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Persona management
  // ────────────────────────────────────────────────────────────────────

  private async loadPersonas(): Promise<void> {
    try {
      const provider = this.context.getService<AIPersonaProvider>(
        "reactor.AIPersonaProvider@1.0.0"
      );
      if (provider) {
        this.personas = await provider.getPersonas();
      }
    } catch {
      logger.warn("[ReactorTui] Could not load personas");
    }
  }

  private showPersonaPanel(): void {
    if (!this.personas.length) {
      this.appendSystem("No personas available.");
      return;
    }

    this.activeSidePanel = "personas";
    this.elements.sidePanelTitle.setContent(" 🧑‍💼 Personas ");

    const lines = this.personas.map((p, i) => {
      const active =
        this.state.persona?.id === p.id ? "{green-fg}●{/green-fg} " : "  ";
      return `${active}${i + 1}. {bold}${p.name}{/bold}\n     ${p.description || ""}`;
    });

    this.elements.sidePanelContent.setContent(
      lines.join("\n\n") +
        "\n\n{gray-fg}Type /persona <number> to select{/gray-fg}"
    );

    this.panel.open = true;
    adjustChatForSidePanel(this.elements, true, this.panel.dock);
  }

  private async selectPersona(index: number): Promise<void> {
    if (index < 0 || index >= this.personas.length) {
      this.appendSystem(`Invalid persona index. Use 1-${this.personas.length}`);
      return;
    }

    const persona = this.personas[index];
    this.state.persona = persona;
    this.appendSystem(`Switched to persona: {bold}${persona.name}{/bold}`);
    this.updateStatusBar();

    // Start a new chat with this persona
    await this.startNewChat(persona.id);
  }

  // ────────────────────────────────────────────────────────────────────
  // Chat session management
  // ────────────────────────────────────────────────────────────────────

  private async startNewChat(personaId?: string): Promise<void> {
    const pid =
      personaId || this.state.persona?.id || "ReactorAIPersona";

    try {
      const result = await this.transport.newChat(pid, {
        streamingMode: this.state.streamingEnabled
          ? StreamingMode.SSE
          : StreamingMode.NONE,
        toolApprovalMode: this.state.toolApprovalMode,
      });

      // Check if the service returned an error response instead of a session
      if (result?.__typename === "ReactorErrorResponse") {
        this.appendChat("error", `{red-fg}Session error: ${result.message || "Unknown error"}{/red-fg}`);
        if (result.suggestion) {
          this.appendChat("system", `{yellow-fg}${result.suggestion}{/yellow-fg}`);
        }
        return;
      }

      this.state.sessionId = result?.sessionId || result?.id || result?._id?.toString() || null;
      this.state.messages = [];
      this.state.tokenCount = 0;
      this.state.tokenPressure = 0;
      this.state.toolIterationLimitInfo = null;

      // Clear chat display
      this.elements.chatPanel.setContent("");

      this.appendSystem(
        `New chat session started` +
          (this.state.persona ? ` with {bold}${this.state.persona.name}{/bold}` : "")
      );
      this.updateStatusBar();
    } catch (err: any) {
      this.appendChat("error", `{red-fg}Failed to start chat: ${err.message}{/red-fg}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // History panel
  // ────────────────────────────────────────────────────────────────────

  private async showHistoryPanel(): Promise<void> {
    this.activeSidePanel = "history";
    this.elements.sidePanelTitle.setContent(" 📜 Chat History ");

    try {
      const chats = await this.transport.listChats({
        personaId: this.state.persona?.id,
      });

      if (!chats.length) {
        this.elements.sidePanelContent.setContent(
          "{gray-fg}No chat history found.{/gray-fg}"
        );
      } else {
        const lines = chats.slice(0, 20).map((c: any, i: number) => {
          const active =
            this.state.sessionId === c.id
              ? "{green-fg}●{/green-fg} "
              : "  ";
          const date = c.updatedAt
            ? new Date(c.updatedAt).toLocaleString()
            : "";
          return `${active}${i + 1}. ${c.id.slice(-8)} ${date}`;
        });

        this.elements.sidePanelContent.setContent(
          lines.join("\n") +
            "\n\n{gray-fg}Type /load <number> to load a chat{/gray-fg}"
        );
      }
    } catch {
      this.elements.sidePanelContent.setContent(
        "{red-fg}Failed to load history.{/red-fg}"
      );
    }

    this.panel.open = true;
    adjustChatForSidePanel(this.elements, true, this.panel.dock);
  }

  // ────────────────────────────────────────────────────────────────────
  // Tools panel
  // ────────────────────────────────────────────────────────────────────

  private showToolsPanel(): void {
    this.activeSidePanel = "tools";
    this.elements.sidePanelTitle.setContent(" 🔧 Tools ");

    if (!this.state.tools.length) {
      this.elements.sidePanelContent.setContent(
        "{gray-fg}No tools configured for this session.{/gray-fg}\n\n" +
          `Approval mode: {bold}${this.state.toolApprovalMode}{/bold}\n` +
          "Use /approve <auto|always|never> to change."
      );
    } else {
      const lines = this.state.tools.map((t: any, i: number) => {
        return `  ${i + 1}. {bold}${t.function?.name || t.name || "unknown"}{/bold}\n` +
          `     ${t.function?.description || t.description || ""}`;
      });

      this.elements.sidePanelContent.setContent(
        lines.join("\n\n") +
          `\n\nApproval mode: {bold}${this.state.toolApprovalMode}{/bold}\n` +
          "Use /approve <auto|always|never> to change."
      );
    }

    this.panel.open = true;
    adjustChatForSidePanel(this.elements, true, this.panel.dock);
  }

  // ────────────────────────────────────────────────────────────────────
  // Files panel
  // ────────────────────────────────────────────────────────────────────

  private showFilesPanel(): void {
    this.activeSidePanel = "files";
    this.elements.sidePanelTitle.setContent(" 📎 Files ");

    if (!this.state.files.length) {
      this.elements.sidePanelContent.setContent(
        "{gray-fg}No files attached.{/gray-fg}\n\n" +
          "Use /file <path> to attach a file."
      );
    } else {
      const lines = this.state.files.map((f: any, i: number) => {
        return `  ${i + 1}. ${f.filename || f.name || "file"}`;
      });

      this.elements.sidePanelContent.setContent(lines.join("\n"));
    }

    this.panel.open = true;
    adjustChatForSidePanel(this.elements, true, this.panel.dock);
  }

  // ────────────────────────────────────────────────────────────────────
  // Debug panel
  // ────────────────────────────────────────────────────────────────────

  private showDebugPanel(): void {
    this.activeSidePanel = "debug";
    this.elements.sidePanelTitle.setContent(" 🐛 Debug ");

    const info = [
      `Session ID: ${this.state.sessionId || "none"}`,
      `Persona: ${this.state.persona?.name || "none"} (${this.state.persona?.id || ""})`,
      `Model: ${this.state.persona?.modelId || "default"}`,
      `Provider: ${this.state.persona?.providerId || "default"}`,
      `Override: ${JSON.stringify(this.state.modelOverride || "none")}`,
      `Tool approval: ${this.state.toolApprovalMode}`,
      `Max iterations: ${this.state.maxToolIterations || "default"}`,
      `Tokens: ${this.state.tokenCount}/${this.state.maxTokens || "—"}`,
      `Pressure: ${(this.state.tokenPressure * 100).toFixed(1)}%`,
      `Streaming: ${this.state.streamingEnabled ? "SSE" : "GQL"}`,
      `Network: ${this.state.networkStatus}`,
      `Transport: ${this.transport.mode}`,
      `Messages: ${this.state.messages.length}`,
      `Voice: ${this.state.voiceModeActive ? "active" : "off"}`,
      `Files: ${this.state.files.length}`,
      `Vars: ${JSON.stringify(this.state.vars)}`,
    ];

    this.elements.sidePanelContent.setContent(info.join("\n"));
    this.panel.open = true;
    adjustChatForSidePanel(this.elements, true, this.panel.dock);
  }

  // ────────────────────────────────────────────────────────────────────
  // Panel toggling
  // ────────────────────────────────────────────────────────────────────

  private toggleSidePanel(name: PanelName): void {
    if (this.panel.open && this.activeSidePanel === name) {
      // Close the panel
      this.panel.open = false;
      this.activeSidePanel = null;
      adjustChatForSidePanel(this.elements, false);
      return;
    }

    // Open the requested panel
    switch (name) {
      case "personas":
        this.showPersonaPanel();
        break;
      case "tools":
        this.showToolsPanel();
        break;
      case "history":
        this.showHistoryPanel();
        break;
      case "files":
        this.showFilesPanel();
        break;
      case "debug":
        this.showDebugPanel();
        break;
      default:
        break;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Keybinding wiring
  // ────────────────────────────────────────────────────────────────────

  private wireKeybindings(): void {
    const { screen } = this.elements;

    // Quit
    screen.key(KEY_BINDINGS.quit.keys, () => this.quit());
    screen.key(KEY_BINDINGS.interrupt.keys, () => this.quit());

    // Help
    screen.key(KEY_BINDINGS.help.keys, () => this.toggleHelp());

    // Chat
    screen.key(KEY_BINDINGS.clearChat.keys, () => {
      this.elements.chatPanel.setContent("");
      this.render();
    });

    screen.key(KEY_BINDINGS.newChat.keys, () => this.startNewChat());

    screen.key(KEY_BINDINGS.toggleStreaming.keys, () => {
      this.state.streamingEnabled = !this.state.streamingEnabled;
      this.appendSystem(
        `Streaming ${this.state.streamingEnabled ? "enabled (SSE)" : "disabled (GQL)"}`
      );
      this.updateStatusBar();
    });

    // Panels
    screen.key(KEY_BINDINGS.togglePersonas.keys, () =>
      this.toggleSidePanel("personas")
    );
    screen.key(KEY_BINDINGS.toggleTools.keys, () =>
      this.toggleSidePanel("tools")
    );
    screen.key(KEY_BINDINGS.toggleHistory.keys, () =>
      this.toggleSidePanel("history")
    );
    screen.key(KEY_BINDINGS.toggleFiles.keys, () =>
      this.toggleSidePanel("files")
    );
    screen.key(KEY_BINDINGS.toggleDebug.keys, () =>
      this.toggleSidePanel("debug")
    );

    // Voice
    screen.key(KEY_BINDINGS.toggleVoice.keys, () => {
      if (this.state.voiceModeActive) {
        // In voice mode, Ctrl+V toggles recording
        this.toggleVoiceRecording();
      } else {
        // First press activates voice mode
        this.state.voiceModeActive = true;
        this.appendSystem(
          "Voice mode activated 🎤 — press Ctrl+V again to record"
        );
        this.updateStatusBar();
      }
    });

    // Tab focus cycling
    screen.key(KEY_BINDINGS.cyclePanels.keys, () => {
      this.focusIndex =
        (this.focusIndex + 1) % this.focusCycle.length;
      this.focusCycle[this.focusIndex].focus();
      this.render();
    });

    // Escape — close overlay OR side-panel
    screen.key(KEY_BINDINGS.closePanel.keys, () => {
      if (!this.elements.helpOverlay.hidden) {
        this.elements.helpOverlay.hide();
        this.render();
        return;
      }
      if (!this.elements.confirmDialog.hidden) {
        this.elements.confirmDialog.hide();
        this.render();
        return;
      }
      if (this.panel.open) {
        this.panel.open = false;
        this.activeSidePanel = null;
        adjustChatForSidePanel(this.elements, false);
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Help overlay
  // ────────────────────────────────────────────────────────────────────

  private toggleHelp(): void {
    if (this.elements.helpOverlay.hidden) {
      this.elements.helpOverlay.setContent(
        formatHelpText() + "\n\n" + formatCommandHelp()
      );
      this.elements.helpOverlay.show();
      this.elements.helpOverlay.focus();
    } else {
      this.elements.helpOverlay.hide();
    }
    this.render();
  }

  // ────────────────────────────────────────────────────────────────────
  // Slash commands
  // ────────────────────────────────────────────────────────────────────

  private registerSlashCommands(): void {
    this.slashCommands = [
      {
        name: "help",
        aliases: ["h", "?"],
        description: "Show help",
        handler: async () => this.toggleHelp(),
      },
      {
        name: "quit",
        aliases: ["q", "exit"],
        description: "Quit ReactorTUI",
        handler: async () => this.quit(),
      },
      {
        name: "new",
        aliases: ["n"],
        description: "Start new chat session",
        handler: async () => this.startNewChat(),
      },
      {
        name: "clear",
        aliases: ["cls"],
        description: "Clear chat display",
        handler: async () => {
          this.elements.chatPanel.setContent("");
          this.render();
        },
      },
      {
        name: "persona",
        aliases: ["p"],
        description: "Select persona by number",
        handler: async (args) => {
          if (!args[0]) {
            this.toggleSidePanel("personas");
            return;
          }
          const idx = parseInt(args[0], 10) - 1;
          await this.selectPersona(idx);
        },
      },
      {
        name: "personas",
        aliases: [],
        description: "Show personas panel",
        handler: async () => this.toggleSidePanel("personas"),
      },
      {
        name: "tools",
        aliases: [],
        description: "Show tools panel",
        handler: async () => this.toggleSidePanel("tools"),
      },
      {
        name: "history",
        aliases: ["hist"],
        description: "Show chat history",
        handler: async () => this.toggleSidePanel("history"),
      },
      {
        name: "load",
        aliases: ["l"],
        description: "Load a chat from history",
        handler: async (args) => {
          if (!args[0]) {
            this.appendSystem("Usage: /load <session-id or index>");
            return;
          }
          await this.loadChatById(args[0]);
        },
      },
      {
        name: "file",
        aliases: ["attach"],
        description: "Attach a file to the session",
        handler: async (args) => {
          if (!args[0]) {
            this.toggleSidePanel("files");
            return;
          }
          await this.attachFile(args.join(" "));
        },
      },
      {
        name: "approve",
        aliases: [],
        description: "Set tool approval mode (auto|always|never)",
        handler: async (args) => {
          const mode = args[0]?.toLowerCase();
          if (!mode || !["auto", "always", "never"].includes(mode)) {
            this.appendSystem(
              `Current mode: ${this.state.toolApprovalMode}. Usage: /approve <auto|always|never>`
            );
            return;
          }
          this.state.toolApprovalMode = mode as ToolApprovalMode;
          if (this.state.sessionId) {
            await this.transport.setToolApprovalMode(
              this.state.sessionId,
              this.state.toolApprovalMode
            );
          }
          this.appendSystem(`Tool approval mode set to: ${mode}`);
          this.updateStatusBar();
        },
      },
      {
        name: "continue",
        aliases: ["cont"],
        description: "Continue tool execution after limit",
        handler: async () => {
          if (!this.state.sessionId || !this.state.persona) {
            this.appendSystem("No active session or persona.");
            return;
          }
          this.state.busy = true;
          this.updateStatusBar();
          await this.transport.continueToolExecution(
            this.state.sessionId,
            this.state.persona.id
          );
        },
      },
      {
        name: "model",
        aliases: ["m"],
        description: "Set model and/or provider override",
        handler: async (args) => {
          const modelId = args[0];
          const providerId = args[1];
          if (!modelId && !providerId) {
            this.appendSystem("Usage: /model <modelId> [providerId]");
            return;
          }
          this.state.modelOverride = { modelId, providerId };
          if (this.state.sessionId) {
            await this.transport.setModelProvider(
              this.state.sessionId,
              modelId,
              providerId
            );
          }
          this.appendSystem(
            `Model override: ${modelId || "default"}` +
              (providerId ? ` / provider: ${providerId}` : "")
          );
          this.updateStatusBar();
        },
      },
      {
        name: "stream",
        aliases: [],
        description: "Toggle streaming mode",
        handler: async () => {
          this.state.streamingEnabled = !this.state.streamingEnabled;
          this.appendSystem(
            `Streaming ${this.state.streamingEnabled ? "enabled (SSE)" : "disabled (GQL)"}`
          );
          this.updateStatusBar();
        },
      },
      {
        name: "voice",
        aliases: ["v"],
        description: "Voice control: /voice [on|off|record|speak|check]",
        handler: async (args) => {
          const sub = args[0]?.toLowerCase();
          if (!sub || sub === "on") {
            this.state.voiceModeActive = true;
            this.appendSystem("Voice mode activated 🎤");
            this.updateStatusBar();
          } else if (sub === "off") {
            this.state.voiceModeActive = false;
            if (this.voiceService?.isRecording) {
              this.voiceService.stopRecording();
            }
            this.appendSystem("Voice mode deactivated");
            this.updateStatusBar();
          } else if (sub === "record" || sub === "rec") {
            this.state.voiceModeActive = true;
            this.toggleVoiceRecording();
          } else if (sub === "speak" || sub === "say") {
            await this.speakLastResponse();
          } else if (sub === "check") {
            if (this.voiceService) {
              const deps = await this.voiceService.checkDependencies();
              this.appendSystem(
                `Voice deps: rec=${deps.rec ? "✓" : "✗"}, ` +
                  `player=${deps.player ? "✓" : "✗"}, ` +
                  `speech-service=${deps.speechService ? "✓" : "✗"}`
              );
            } else {
              this.appendSystem("{yellow-fg}Voice service not initialized.{/yellow-fg}");
            }
          } else {
            this.appendSystem(
              "Usage: /voice [on|off|record|speak|check]"
            );
          }
        },
      },
      {
        name: "debug",
        aliases: ["d"],
        description: "Toggle debug panel",
        handler: async () => this.toggleSidePanel("debug"),
      },
      {
        name: "dock",
        aliases: [],
        description: "Change side panel dock side (left|right)",
        handler: async (args) => {
          const side = args[0]?.toLowerCase();
          if (side === "left" || side === "right") {
            this.panel.dock = side as DockSide;
            if (this.panel.open) {
              adjustChatForSidePanel(this.elements, true, this.panel.dock);
            }
            this.appendSystem(`Side panel docked ${side}`);
          } else {
            this.appendSystem("Usage: /dock <left|right>");
          }
        },
      },
      {
        name: "tokens",
        aliases: [],
        description: "Show token usage details",
        handler: async () => {
          this.appendSystem(
            `Tokens: ${this.state.tokenCount}/${this.state.maxTokens || "—"} ` +
              `(pressure: ${(this.state.tokenPressure * 100).toFixed(1)}%)`
          );
        },
      },
    ];
  }

  // ────────────────────────────────────────────────────────────────────
  // Chat loading
  // ────────────────────────────────────────────────────────────────────

  private async loadChatById(idOrIndex: string): Promise<void> {
    const sessionId = idOrIndex;

    try {
      const chat = await this.transport.loadChat(sessionId);
      if (!chat) {
        this.appendChat("error", "Chat session not found.");
        return;
      }

      this.state.sessionId = chat.id;
      this.state.messages = [];
      this.elements.chatPanel.setContent("");

      // Replay history
      if (chat.history && Array.isArray(chat.history)) {
        for (const msg of chat.history) {
          this.addMessage({
            id: new ObjectId().toHexString(),
            role: msg.role || "system",
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content),
            timestamp: new Date(),
          });
        }
      }

      this.appendSystem(`Loaded chat session: ${chat.id}`);
      this.updateStatusBar();
    } catch (err: any) {
      this.appendChat("error", `{red-fg}Failed to load chat: ${err.message}{/red-fg}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // File attachments
  // ────────────────────────────────────────────────────────────────────

  private async attachFile(filePath: string): Promise<void> {
    if (!this.state.sessionId) {
      this.appendSystem("Start a chat first.");
      return;
    }

    try {
      const result = await this.transport.uploadFile(
        filePath,
        this.state.sessionId
      );
      this.state.files.push(result);
      this.appendSystem(`File attached: ${filePath}`);
    } catch (err: any) {
      this.appendChat("error", `{red-fg}File attach failed: ${err.message}{/red-fg}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Voice
  // ────────────────────────────────────────────────────────────────────

  private wireVoiceEvents(): void {
    if (!this.voiceService) return;

    this.voiceService.on("recording:start", () => {
      this.appendSystem("{red-fg}🎤 Recording… press Ctrl+V to stop{/red-fg}");
      this.updateStatusBar();
    });

    this.voiceService.on("recording:stop", async (buffer: Buffer) => {
      this.appendSystem("🎤 Recording stopped. Transcribing…");
      try {
        const text = await this.voiceService!.transcribe(buffer);
        if (text && text.trim()) {
          this.appendSystem(`Transcription: "${text.trim()}"`);
          await this.sendChatMessage(text.trim());
        } else {
          this.appendSystem("{yellow-fg}No speech detected.{/yellow-fg}");
        }
      } catch (err: any) {
        this.appendChat(
          "error",
          `{red-fg}Transcription failed: ${err.message}{/red-fg}`
        );
      }
      this.updateStatusBar();
    });

    this.voiceService.on("recording:error", (err: Error) => {
      this.appendChat(
        "error",
        `{red-fg}Recording error: ${err.message}{/red-fg}`
      );
    });

    this.voiceService.on("playback:start", () => {
      this.updateStatusBar();
    });

    this.voiceService.on("playback:stop", () => {
      this.updateStatusBar();
    });
  }

  private toggleVoiceRecording(): void {
    if (!this.voiceService) {
      this.appendSystem(
        "{yellow-fg}Voice service not available.{/yellow-fg}"
      );
      return;
    }

    if (this.voiceService.isRecording) {
      this.voiceService.stopRecording();
    } else {
      this.voiceService.startRecording();
    }
  }

  /**
   * Speak the last assistant response via TTS.
   */
  private async speakLastResponse(): Promise<void> {
    if (!this.voiceService) return;

    const lastAssistant = [...this.state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) {
      this.appendSystem("No assistant message to speak.");
      return;
    }

    try {
      this.appendSystem("🔊 Synthesizing speech…");
      const audio = await this.voiceService.synthesize(
        lastAssistant.content
      );
      await this.voiceService.playAudio(audio);
    } catch (err: any) {
      this.appendChat(
        "error",
        `{red-fg}TTS failed: ${err.message}{/red-fg}`
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Cleanup
  // ────────────────────────────────────────────────────────────────────

  private quit(): void {
    this.transport.disconnect();
    if (this.voiceService) {
      this.voiceService.destroy();
    }
    if (this.elements.spinnerInterval) {
      clearInterval(this.elements.spinnerInterval);
    }
    // Restore console methods before destroying the screen
    if (this._origConsole) {
      console.log = this._origConsole.log;
      console.warn = this._origConsole.warn;
      console.error = this._origConsole.error;
      console.debug = this._origConsole.debug;
      console.info = this._origConsole.info;
    }
    // Restore winston Console transport
    if (this._removedWinstonTransport) {
      logger.add(this._removedWinstonTransport);
    }
    this.elements.screen.destroy();
    // Resolve the blocking promise so the CLI dispatcher can exit naturally
    if (this._exitResolve) {
      this._exitResolve();
    }
  }

  private render(): void {
    this.elements.screen.render();
  }
}

// ── CLI entry-point wrapper ────────────────────────────────────────────

export default async function ReactorTuiApp(
  kwargs: string[],
  context: Reactory.Server.IReactoryContext
): Promise<void> {
  const tui = new ReactorTui(context);
  await tui.start();
}
