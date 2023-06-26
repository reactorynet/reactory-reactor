

/**
 * Defines a function that formats and array of pathInfos into a string
 */
export type DirectoryListFormatter = (pathInfos: PathInfo[]) => string;

/**
 * Defines a service that can format a list of path infos into a string
 */
export type DirectoryListFormatterService = Reactory.Service.IReactoryService & {
  formatter: DirectoryListFormatter;
}
/**
 * Defines a Path Informaiton object that contains information about a file or directory
 */
export type PathInfo = {
  name: string;
  extension: string;
  size: number;
  created?: Date;
  modified?: Date;
  accessed?: Date;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  isBlockDevice?: boolean;
  isCharacterDevice?: boolean;
  isFIFO?: boolean;
  isSocket?: boolean;
  isWritable: boolean;
  isReadable: boolean;
  isExecutable: boolean;
  owner: string;
  group: string;
  mode?: string;
  path?: string;
  absolutePath?: string;
  relativePath?: string;
  parentPath?: string;
  parentAbsolutePath?: string;
  parentRelativePath?: string;
  error?: Error;
}

/**
 * Shell command macro output type
 */
export type ShellCommandMacroOutput = string | { stdout: string, stderr: string };
/**
 * Shell command macro arguments
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