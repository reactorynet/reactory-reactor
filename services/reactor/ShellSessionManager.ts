import { service } from '@reactory/server-core/application/decorators/service';
import { ObjectId } from 'mongodb';
import os from 'os';
import { StreamingTransportManager } from './StreamingTransportManager';
import { ShellStreamPublisher } from './streaming/ShellStreamPublisher';

/**
 * Minimal structural type for a node-pty process. Declared locally so this
 * module compiles and loads even when the optional native `node-pty` dependency
 * is not installed — only actually opening a session requires it at runtime.
 */
interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: {
    name?: string; cols?: number; rows?: number; cwd?: string;
    env?: NodeJS.ProcessEnv; encoding?: string;
  }): IPty;
}

/** Arguments for opening an interactive shell session. */
export interface CreateShellSessionArgs {
  /** Streaming channel the terminal output routes onto (chat conversation id). */
  channelId: string;
  /** Shell binary to launch. Defaults to the user's $SHELL or /bin/bash. */
  shell?: string;
  /** Working directory for the session. Defaults to APP_DATA_ROOT / cwd. */
  cwd?: string;
  /** Initial terminal columns. */
  cols?: number;
  /** Initial terminal rows. */
  rows?: number;
  /** Extra environment variables merged over a curated base set. */
  env?: Record<string, string>;
}

interface ShellSession {
  id: string;
  channelId: string;
  userId: string;
  pty: IPty;
  shell: string;
  cwd: string;
  createdAt: Date;
  lastActivity: Date;
  publisher: ShellStreamPublisher;
}

/** Environment variables safe to forward into an interactive shell. */
const SAFE_ENV_VARS = [
  'PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TERM',
  'LC_ALL', 'LC_CTYPE', 'EDITOR', 'VISUAL',
  'APP_DATA_ROOT', 'NODE_ENV', 'REACTORY_SERVER',
  'REACTORY', 'REACTORY_CLIENT', 'REACTORY_CORE', 'REACTORY_DATA', 'REACTORY_HOME',
];

/** Roles permitted to open an interactive PTY. */
const SHELL_ROLES = ['ADMIN', 'DEVELOPER', 'SHELL-EXEC'];

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // reap sessions idle > 30 minutes
const REAP_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS_PER_USER = 5;

/**
 * Manages long-lived, stateful interactive shell (PTY) sessions for the human
 * shell widget. Unlike the one-shot `shell` macro (which is stateless and
 * per-command), a session here holds a real terminal — cwd, history, running
 * programs, signals — for the lifetime of the widget.
 *
 * ⚠️ Security: a PTY streams raw keystrokes, so the regex command-filtering used
 * by the one-shot macro CANNOT apply. Opening a session is therefore strictly
 * more privileged and is gated behind {@link SHELL_ROLES} + the
 * DENY_SHELL_EXECUTION env flag. Treat "can open a PTY" as a superuser-grade
 * capability.
 *
 * Output flows OUT to the client over the existing SSE transport as `shell`
 * events (via {@link ShellStreamPublisher}); keystrokes flow IN via
 * {@link write} (wired to a REST/GraphQL input route — see ShellEndpoints).
 */
@service({
  id: 'reactor.ShellSessionManager@1.0.0',
  nameSpace: 'reactor',
  name: 'ShellSessionManager',
  version: '1.0.0',
  description: 'Manages interactive PTY shell sessions for the shell widget',
  dependencies: [],
  lifeCycle: 'singleton',
})
export class ShellSessionManager implements Reactory.Service.IReactoryService {
  private readonly context: Reactory.Server.IReactoryContext;
  private readonly sessions = new Map<string, ShellSession>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  private static instance: ShellSessionManager;
  private static ptyModule: NodePtyModule | null | undefined;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.context = context;
    if (!ShellSessionManager.instance) {
      ShellSessionManager.instance = this;
      this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
      // Don't keep the event loop alive solely for the reaper.
      if (typeof this.reaper.unref === 'function') this.reaper.unref();
    }
    return ShellSessionManager.instance;
  }

  /** Lazily resolve the optional native node-pty module with a helpful error. */
  private static getPty(): NodePtyModule {
    if (ShellSessionManager.ptyModule === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ShellSessionManager.ptyModule = require('node-pty') as NodePtyModule;
      } catch {
        ShellSessionManager.ptyModule = null;
      }
    }
    if (!ShellSessionManager.ptyModule) {
      throw new Error(
        'Interactive shell sessions require the "node-pty" package. Install it in reactory-express-server (npm install node-pty).',
      );
    }
    return ShellSessionManager.ptyModule;
  }

  /**
   * Enforce role + kill-switch gating for opening a PTY.
   * Auth is evaluated against the PER-REQUEST context (this service is a
   * singleton, so `this.context` — captured at construction — must NOT be
   * used for authorization).
   */
  private assertAuthorized(context: Reactory.Server.IReactoryContext): void {
    if (process.env.DENY_SHELL_EXECUTION === 'true') {
      throw new Error('Unauthorized: Shell execution is disabled.');
    }
    if (!context?.hasAnyRole?.(SHELL_ROLES)) {
      throw new Error('Unauthorized: User does not have the necessary role to open a shell session.');
    }
  }

  private static userIdOf(context: Reactory.Server.IReactoryContext): string {
    return context?.user?._id ? String(context.user._id) : 'anonymous';
  }

  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    for (const key of SAFE_ENV_VARS) {
      if (process.env[key] !== undefined) base[key] = process.env[key];
    }
    base.TERM = base.TERM || 'xterm-256color';
    return { ...base, ...(extra || {}) };
  }

  /**
   * Open a new interactive shell session. Emits a `start` shell event and
   * begins streaming output on the given channel. Returns the session id the
   * client uses to write keystrokes / resize / kill.
   */
  async create(args: CreateShellSessionArgs, context: Reactory.Server.IReactoryContext): Promise<{ shellSessionId: string; pid: number; shell: string; cwd: string }> {
    this.assertAuthorized(context);

    const userId = ShellSessionManager.userIdOf(context);
    const active = Array.from(this.sessions.values()).filter((s) => s.userId === userId);
    if (active.length >= MAX_SESSIONS_PER_USER) {
      throw new Error(`Session limit reached (${MAX_SESSIONS_PER_USER}). Close an existing shell session first.`);
    }

    const pty = ShellSessionManager.getPty();
    const shell = args.shell || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
    const cwd = args.cwd || process.env.APP_DATA_ROOT || process.cwd();
    const shellSessionId = new ObjectId().toString();

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: args.cols && args.cols > 0 ? args.cols : 80,
      rows: args.rows && args.rows > 0 ? args.rows : 24,
      cwd,
      env: this.buildEnv(args.env),
      encoding: 'utf8',
    });

    const publisher = ShellStreamPublisher.fromContext(context, {
      channelId: args.channelId,
      shellSessionId,
      source: 'widget',
    });

    const session: ShellSession = {
      id: shellSessionId,
      channelId: args.channelId,
      userId,
      pty: ptyProcess,
      shell,
      cwd,
      createdAt: new Date(),
      lastActivity: new Date(),
      publisher,
    };
    this.sessions.set(shellSessionId, session);

    // node-pty merges stdout+stderr onto a single stream.
    ptyProcess.onData((data: string) => {
      session.lastActivity = new Date();
      publisher.stdout(data);
    });
    ptyProcess.onExit(({ exitCode }) => {
      publisher.exit(exitCode ?? 0);
      this.sessions.delete(shellSessionId);
    });

    publisher.start(shell, cwd, ptyProcess.pid);
    context.info(`[ShellSessionManager] Opened session ${shellSessionId} (${shell}) for user ${userId} on channel ${args.channelId}`);

    return { shellSessionId, pid: ptyProcess.pid, shell, cwd };
  }

  /** Resolve a session, asserting the requesting user owns it (or is ADMIN). */
  private getOwned(shellSessionId: string, context: Reactory.Server.IReactoryContext): ShellSession {
    const session = this.sessions.get(shellSessionId);
    if (!session) throw new Error(`Shell session ${shellSessionId} not found`);
    const userId = ShellSessionManager.userIdOf(context);
    if (session.userId !== userId && !context?.hasAnyRole?.(['ADMIN'])) {
      throw new Error('Unauthorized: shell session belongs to another user.');
    }
    return session;
  }

  /** Write keystrokes / input to a session's PTY. */
  write(shellSessionId: string, data: string, context: Reactory.Server.IReactoryContext): void {
    const session = this.getOwned(shellSessionId, context);
    session.lastActivity = new Date();
    session.pty.write(data);
  }

  /** Resize a session's PTY (e.g. on xterm fit). */
  resize(shellSessionId: string, cols: number, rows: number, context: Reactory.Server.IReactoryContext): void {
    const session = this.getOwned(shellSessionId, context);
    if (cols > 0 && rows > 0) session.pty.resize(cols, rows);
  }

  /** Terminate a session and its PTY. */
  kill(shellSessionId: string, context: Reactory.Server.IReactoryContext, signal: string = 'SIGTERM'): void {
    const session = this.sessions.get(shellSessionId);
    if (!session) return;
    this.getOwned(shellSessionId, context);
    try { session.pty.kill(signal); } catch { /* already dead */ }
    this.sessions.delete(shellSessionId);
  }

  /** List the requesting user's active sessions (metadata only). */
  list(context: Reactory.Server.IReactoryContext): Array<{ shellSessionId: string; channelId: string; shell: string; cwd: string; createdAt: Date; lastActivity: Date }> {
    const userId = ShellSessionManager.userIdOf(context);
    return Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .map(({ id, channelId, shell, cwd, createdAt, lastActivity }) => ({ shellSessionId: id, channelId, shell, cwd, createdAt, lastActivity }));
  }

  /** Reap sessions idle beyond IDLE_TIMEOUT_MS. */
  private reapIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > IDLE_TIMEOUT_MS) {
        this.context.debug(`[ShellSessionManager] Reaping idle shell session ${id}`);
        try { session.pty.kill(); } catch { /* noop */ }
        this.sessions.delete(id);
      }
    }
  }

  description?: string = 'Manages interactive PTY shell sessions for the shell widget';
  tags?: string[] = ['reactor', 'shell', 'pty', 'terminal'];
  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}@${this.version}`;
  }
  nameSpace: string = 'reactor';
  name: string = 'ShellSessionManager';
  version: string = '1.0.0';
}

export default ShellSessionManager;
