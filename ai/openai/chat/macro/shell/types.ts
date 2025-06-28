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
  timeoutInSeconds?: string;
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