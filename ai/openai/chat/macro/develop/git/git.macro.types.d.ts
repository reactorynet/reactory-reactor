//current set of supported operations
export type GitMacroOperation = string & ('status' | 'commit' | 'push' | 'pull' | 'clone');
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