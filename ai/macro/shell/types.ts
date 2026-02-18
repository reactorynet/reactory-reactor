/**
 * Shell command macro output type
 */
export type ShellCommandMacroOutput = string | { stdout: string, stderr: string };

/**
 * Shell command macro properties interface
 */
export interface ShellCommandProps {
  /**
   * The shell command to execute
   */
  command: string;
  /**
   * The working directory to execute the command in
   * @default process.cwd()
   * @example /home/user
   * @example /home/user/my-project
   */
  workingDir?: string;
  /**
   * The template id to use for the shell command
   * @default default
   * @example gitshell
   */
  templateId?: string;
  /**
   * The timeout in seconds for the shell command
   * @default 60
   * @example 120
   */
  timeoutInSeconds?: string | number;
  /**
   * Whether to execute the shell command with sudo
   * @default false
   */
  sudo?: "true" | "false";
  /**
   * The format of the output
   */
  format?: "string" | "object";
  /**
   * the shell to use
   */
  shell?: "/bin/bash" | "/bin/zsh";
}

/**
 * Shell command macro arguments
 * @deprecated Use ShellCommandProps instead
 */
export type ShellCommandArgs = [
  /**
   * The shell command to execute
   */
  command: string,
  /**
   * The working directory to execute the command in
   * @default process.cwd()
   * @example /home/user
   * @example /home/user/my-project
   * */
  workingDir?: string,
  /**
   * The template id to use for the shell command
   * @default default
   * @example gitshell
   * */
  templateId?: string,
  /**
   * The timeout in seconds for the shell command
   * @default 60
   * @example 120
   * */
  timeoutInSeconds?: string,
  /**
   * Whether to execute the shell command with sudo
   * @default false
   * */
  sudo?: "true" | "false",
  /**
   * The format of the output
   */
  format?: "string" | "object",
  /**
   * the shell to use
   */
  shell?: "/bin/bash" | "/bin/zsh"
]

/**
 * Return type for ShellCommand macro
 */
export interface ShellCommandResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Shell command execution data if operation succeeded */
  data?: {
    /** Standard output from the command */
    stdout: string;
    /** Standard error output from the command */
    stderr: string;
    /** Combined output (stdout + stderr) */
    output: string;
    /** Exit code of the command */
    exitCode: number;
    /** Whether the command completed successfully (exit code 0) */
    success: boolean;
    /** Command that was executed */
    command: string;
    /** Working directory where command was executed */
    workingDir: string;
    /** Shell used for execution */
    shell: string;
    /** Template ID used */
    templateId: string;
    /** Whether sudo was used */
    sudo: boolean;
    /** Execution time in milliseconds */
    executionTime: number;
    /** Whether the command timed out */
    timedOut: boolean;
    /** Process ID of the executed command */
    pid?: number;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: ShellCommandProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Command that was executed */
    command: string;
    /** Working directory */
    workingDir: string;
    /** Shell used */
    shell: string;
    /** Template ID used */
    templateId: string;
    /** Whether sudo was used */
    sudo: boolean;
    /** Exit code */
    exitCode?: number;
    /** Whether command timed out */
    timedOut?: boolean;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}