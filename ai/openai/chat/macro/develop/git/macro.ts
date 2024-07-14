import pathModule from 'path';
import os from 'os';
import { promises as fs, readFileSync, existsSync, mkdirSync } from 'fs';
import { ChatState, Macro } from 'modules/reactory-reactor/ai/openai/types/chat';
import { RemoveDirectory } from '../../fs/macro';
import { ShellCommand } from '../../shell/macro'
import { template } from 'lodash';
import { ShellCommandArgs } from '../../shell/types';
import Reactory from '@reactory/reactory-core';
import { GitMacroArgs } from './types';


/**
 * A function that checks if the git ignore file exists
 * if not it creates one
 */
const checkGitIgnore = async (target: string, state: ChatState) => { 
  // Create a .gitignore file if it does not exist
  const shArgs: ShellCommandArgs = [ 
    `git add .gitignore`,
    target,
    'git',
    '5',
    'false',
    'string'
  ];

  const gitIgnorePath = pathModule.join(target, '.gitignore');
  if (!existsSync(gitIgnorePath)) {
    await fs.writeFile(gitIgnorePath, '');
    // Add .gitignore to staging area
    
    await ShellCommand(shArgs, state);
    // Commit the changes
    shArgs[0] = `git commit -m "Add .gitignore"`;
    await ShellCommand(shArgs, state);
  }
}

/**
 * Checks out a git branch if it exists
 * @param branch - the branch to checkout
 * @param target - the target folder
 * @param state - the current chat state
 * @returns 
 */
const checkoutBranch = async (branch: string, target: string, state: ChatState) => { 
  // Checkout the branch
  const shArgs: ShellCommandArgs = [ 
    `git checkout ${branch}`,
    target,
    'git',
    '5',
    'false',
    'string'
  ];

  await ShellCommand(shArgs, state);
  return checkBranch(branch, target, state);
}

/**
 * Checks a git branch
 * @param branch 
 * @param target 
 */
const checkBranch = async (branch: string, target: string, state: ChatState) => {
  // Check git status
  const { stderr, stdout } = await ShellCommand([`git status`, target, 'git', '5', 'false', 'object'], state) as unknown as {stdout: string, stderr: string};
  // Ensure branch specification and output match
  if(stderr) {
    throw new Error(stderr);
  }

  const isOnCorrectBranch = stdout?.includes(`On branch ${branch}`) || false;
  if (!isOnCorrectBranch) {
    throw new Error(`Current branch does not match the specified branch ${branch}.`);
  }
  return `${branch} is the current branch`;
};

/**
 * Clones a repo
 * @param repo 
 * @param target 
 * @param branch 
 */
const cloneRepo = async (repo: string, target: string, branch: string, overwrite: boolean = false, state: ChatState): Promise<string> => {
  //check if the target folder contains the repo name already
  const repoName = repo.split('/').pop().replace('.git', '');
  let $target = target; //$target is the target folder
  if ($target.endsWith(repoName)) {
    $target = $target.replace(repoName, '');
  }

  const targetPath = pathModule.join($target, repoName);
  //check if the target folder exists and create it if it does not
  if (!existsSync(targetPath)) {
    mkdirSync(targetPath, { recursive: true });
  } else {
    //check if the target folder exists and whether to overwrite it
    if (existsSync($target) === true && overwrite === false) throw new Error(`Target folder ${targetPath} already exists. Use overwrite flag to overwrite the folder.`);
    if (existsSync($target) === true && overwrite === true) await RemoveDirectory([$target], state);
  }
  // Clone the repo
  let shArgs: ShellCommandArgs = [
    `git clone ${repo} ${targetPath} --branch ${branch}`,
    targetPath,
    'git',
    '120',
    'false',
    'object'
  ];

  const { stderr: cloneErr, stdout: cloneOut } = await ShellCommand(shArgs, state) as unknown as {stdout: string, stderr: string};
  if (cloneErr) { 
    throw new Error(cloneErr);
  }

  if (cloneOut && !cloneOut?.includes('Cloning into')) throw new Error(`Could not clone the repository ${repo} to ${targetPath}`);
  // Check if target folder exists
  if (!existsSync(targetPath)) {
    throw new Error(`Target folder ${targetPath} does not exist after cloning.`);
  }

  //check if .git folder exists
  const gitPath = pathModule.join(targetPath, '.git');
  if (!existsSync(gitPath)) {
    throw new Error(`.git folder does not exist after cloning.`);
  }
  
  return `Successfully cloned the repository ${repo} to ${targetPath} and checked out branch ${branch}`
};


const pullRepo = async (repo: string, target: string, branch: string, state: ChatState) => {
  // Pull the repo
  await ShellCommand([`git pull ${repo} ${branch}`], state);
  // Post pulling check
  // Check if target folder exists
  if (!existsSync(target)) {
    throw new Error(`Target folder ${target} does not exist after pulling.`);
  }
  // Check branch
  await checkBranch(branch, target, state);
};

/**
 * Performs a git status
 * @param target 
 * @returns 
 */
const gitStatus = async (target: string, state: ChatState) => {
  // Get the status of the current git repository
  const { stdout: statusOut, stderr: statusError } = await ShellCommand([
    `git status`, 
    target, 
    'git', 
    '60', 
    'false', 
    'object'], state) as { stdout: string, stderr: string }
  
    if(statusError) throw new Error(statusError);
    return statusOut;
};

const commitRepo = async (target: string, commitMessage: string, state: ChatState) => {
  // Add all changes to staging area
  await ShellCommand([`git add .`,
    target,
    'git',
    '60',
    'false',
    'object'], state);
  // Commit the changes
  const { stdout, stderr } = await ShellCommand([`git commit -m "${commitMessage}"`,
    target,
    'git',
    '60',
    'false',
    'object'], state) as unknown as {stdout: string, stderr: string};

  if (stderr) throw new Error(stderr);
  if (!stdout.includes('file changed')) throw new Error(`Could not commit changes to the repository at ${target} with message "${commitMessage}"`);
};

const pushRepo = async (repo: string, target: string, branch: string, state: ChatState) => {
  // Push the commit to the repo
  await ShellCommand([`git push ${repo} ${branch}`, target, 'git', '60', 'false', 'object'], state);
};

/**
 * A macro that will perform git operations
 * @param args 
 * @param state 
 * @returns 
 */
export const GitMacro: Macro<string> = async (
  args: GitMacroArgs,
  state: ChatState) => {

  const [operation, ...options] = args;

  let [repo, target, branch = 'master', overwrite = 'false'] = options;

  if (!repo && operation === 'clone') return 'A request to clone a repository requires a valid repository url';
  if (!target) return 'A git request requires a target folder';

  if (repo.indexOf('${') > -1) repo = template(repo)({ os, pathModule, process, state });
  if (target.indexOf('${') > -1) target = template(target)({ os, pathModule, process, state });
  if (branch.indexOf('${') > -1) branch = template(branch)({ os, pathModule, process, state });

  switch (operation) {
    case 'clone':
      try {
        return await cloneRepo(repo, target, branch, overwrite === 'true', state);
      } catch (err) {
        return `Could not clone the repository due to an error ${err.message}`;
      }
    case 'pull':
      try {
        await pullRepo(repo, target, branch, state);
        return `Successfully pulled the repository ${repo} from branch ${branch} to ${target}`;
      } catch (err) {
        return `Could not pull the repository due to an error ${err.message}`;
      }
    case 'commit':
      const commitMessage = 'your commit message'; // replace with actual commit message
      try {
        await commitRepo(target, commitMessage, state);
        return `Successfully committed changes to the repository at ${target} with message "${commitMessage}"`;
      } catch (err) {
        return `Could not commit changes due to an error ${err.message}`;
      }

    case 'push':
      try {
        await pushRepo(repo, target, branch, state);
        return `Successfully pushed changes to the repository ${repo} on branch ${branch} from ${target}`;
      } catch (err) {
        return `Could not push changes due to an error ${err.message}`;
      }
    case 'status':
      try {
        const status = await gitStatus(target, state);
        return status;
      } catch (err) {
        return `Could not retrieve git status due to an error ${err.message}`;
      }
    case 'checkout': {
      try {
        return await checkoutBranch(branch, target, state);
      } catch (err) {
        return `Could not check out branch ${branch} due to an error ${err.message}`;
      }
    }
    default:
      return `Operation: ${operation} not supported. Available operations are: clone, pull, push, commit, status`;
  }
};

const GitMacroComponentDefinition: Reactory.IReactoryComponentDefinition<typeof GitMacro> = { 
  component: GitMacro,
  nameSpace: 'reactor',
  name: 'GitMacro',
  version: '1.0.0',
  description: readFileSync(require.resolve('./readme.md')).toString(),
  features: [{ 
    feature: 'clone',
    featureType: Reactory.FeatureType.function,
    action: ['clone', 'git', 'repository'],
    description: 'Clones a git repository',
    stem: 'clone'
  }],
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['git', 'repository', 'clone', 'pull', 'push', 'commit', 'status', 'checkout'],
};

export default GitMacroComponentDefinition;
