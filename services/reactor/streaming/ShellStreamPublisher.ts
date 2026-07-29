import { StreamingTransportManager } from "../StreamingTransportManager";
import { StreamingEventFactory } from "./StreamingEventFactory";
import { ShellStreamSource } from "../types/streaming.types";

/**
 * Identifiers a shell producer needs in order to publish output to a client.
 */
export interface ShellStreamPublisherOptions {
  /**
   * The streaming channel to route events onto. This is whatever key the
   * StreamingTransportManager knows a transport by:
   *   - chat conversations  → the conversation / chat session id
   *   - workflow runs        → the workflow run id (a streaming session must
   *                            have been created + connected under that id)
   */
  channelId: string;
  /** Terminal identity — groups every event for one process / PTY session. */
  shellSessionId: string;
  /** Origin of the stream, drives client-side grouping. */
  source: ShellStreamSource;
  /** Optional message id to correlate with a chat message. */
  messageId?: string;
}

/**
 * Thin, dependency-free bridge that publishes shell lifecycle + output events
 * onto an active streaming transport. Shared by:
 *   - the one-shot `shell` macro (source: 'macro')
 *   - the interactive PTY widget via ShellSessionManager (source: 'widget')
 *   - the workflow `cli_command` step (source: 'workflow')
 *
 * Design notes:
 *  - Emission is **best-effort and non-throwing** — a producer must never fail
 *    because nobody is listening.
 *  - We gate on `hasActiveTransportForChat` so that high-volume terminal output
 *    is NOT buffered into the transport manager's replay buffer when no client
 *    is connected. (Interactive terminals keep their own client-side scrollback,
 *    and a live PTY keeps flowing after reconnect — so replay is unnecessary and
 *    would risk unbounded buffering.)
 */
export class ShellStreamPublisher {
  private constructor(
    private readonly tm: StreamingTransportManager | undefined,
    private readonly opts: ShellStreamPublisherOptions,
  ) {}

  /**
   * Build a publisher, resolving the StreamingTransportManager from a Reactory
   * context. Returns a no-op publisher when the context, service, or channel
   * is unavailable (e.g. the macro was invoked from the CLI / tool-only path
   * that passes no context).
   */
  static fromContext(
    context: Reactory.Server.IReactoryContext | undefined,
    opts: ShellStreamPublisherOptions,
  ): ShellStreamPublisher {
    let tm: StreamingTransportManager | undefined;
    try {
      tm = context?.getService?.(
        "reactor.StreamingTransportManager@1.0.0",
      ) as StreamingTransportManager | undefined;
    } catch {
      tm = undefined;
    }
    return new ShellStreamPublisher(tm, opts);
  }

  /** Whether a connected client transport exists for this channel right now. */
  get active(): boolean {
    return (
      !!this.tm &&
      !!this.opts.channelId &&
      this.tm.hasActiveTransportForChat(this.opts.channelId)
    );
  }

  private emit(data: {
    phase: "start" | "stdout" | "stderr" | "exit";
    chunk?: string;
    command?: string;
    cwd?: string;
    pid?: number;
    exitCode?: number;
    timedOut?: boolean;
  }): void {
    if (!this.active) return;
    const { channelId, shellSessionId, source, messageId } = this.opts;
    const event = StreamingEventFactory.createShellEvent(
      { shellSessionId, source, ...data },
      { sessionId: channelId, conversationId: channelId, messageId },
    );
    // Fire-and-forget; swallow transport errors so producers never break.
    void this.tm!.sendEventToSession(channelId, event).catch(() => {});
  }

  start(command: string, cwd?: string, pid?: number): void {
    this.emit({ phase: "start", command, cwd, pid });
  }

  stdout(chunk: string): void {
    if (chunk) this.emit({ phase: "stdout", chunk });
  }

  stderr(chunk: string): void {
    if (chunk) this.emit({ phase: "stderr", chunk });
  }

  exit(exitCode: number, timedOut = false): void {
    this.emit({ phase: "exit", exitCode, timedOut });
  }
}
