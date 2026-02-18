//current set of supported operations
export type GitMacroOperation = string & ('status' | 'commit' | 'push' | 'pull' | 'clone' | 'checkout' | 'branch' | 'merge' | 'stash' | 'log' | 'diff' | 'add');
/**
 * The target folder where the git repository will be cloned to, or where the git operation will be performed
 */
export type GitMacroTarget = string;
/**
 * The repository that will be cloned, checked out, or pushed to
 */
export type GitMacroRepo = string;
/**
 * The branch that will be cloned, checked out, or pushed to
 */
export type GitBranch = string;
/**
 * Whether or not to overwrite the target folder if it already exists
 */
export type GitOverwrite = 'true' | 'false';

export type GitMacroOptionArgs = [GitMacroRepo, GitMacroTarget, GitBranch, GitOverwrite];

/**
 * The arguments that will be passed to the git operation
 */
export type GitMacroArgs = [GitMacroOperation, ...GitMacroOptionArgs];

/**
 * Named properties interface for git macro operations.
 * AI agents should use this format for tool calls.
 */
export interface GitMacroProps {
  /** The git operation to perform */
  operation: GitMacroOperation;
  /** The repository URL (required for clone, pull, push) */
  repo?: string;
  /** The target working directory */
  target: string;
  /** The branch name (default: master) */
  branch?: string;
  /** Whether to overwrite existing files/directories */
  overwrite?: boolean;
  /** Commit message (for commit operation) */
  commitMessage?: string;
  /** File or pattern to add (for add operation) */
  file?: string;
  /** Branch name to create or delete (for branch operation) */
  branchName?: string;
  /** Whether to delete a branch (for branch -d) */
  deleteBranch?: boolean;
  /** Source branch for merge (for merge operation) */
  sourceBranch?: string;
  /** Stash sub-action: save, pop, list, drop, apply */
  stashAction?: 'save' | 'pop' | 'list' | 'drop' | 'apply';
  /** Stash message or index */
  stashRef?: string;
  /** Number of log entries to show (for log operation, default: 20) */
  logCount?: number;
  /** Diff target (branch, commit hash, or file) */
  diffTarget?: string;
  /** Whether to show only file names (stat) in diff */
  diffStat?: boolean;
}