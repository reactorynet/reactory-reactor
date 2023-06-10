import pathModule from 'path';
import os from 'os';
import { promises as fs, readFileSync, existsSync, mkdirSync } from 'fs';
import { ChatState, Macro } from '@reactory/server-modules/reactor/types/chat.types';
import { RemoveDirectory } from '../../fs/fs.macro';
import { ShellCommand as exec } from '../../shell/shell.macro'

import { template } from 'lodash';
import { ShellCommandArgs } from 'modules/reactor/types/macro.types';
import Reactory from '@reactory/reactory-core';
import { GitMacroArgs } from './git.macro.types';


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
    
    await exec(shArgs, state);
    // Commit the changes
    shArgs[0] = `git commit -m "Add .gitignore"`;
    await exec(shArgs, state);
  }
}

/**
 * Checks a git branch
 * @param branch 
 * @param target 
 */
const checkBranch = async (branch: string, target: string, state: ChatState) => {
  // Check git status
  const out = await exec([`git status`, target, 'git', '5', 'object'], state) as unknown as {stdout: string, stderr: string};
  // Ensure branch specification and output match
  const isOnCorrectBranch =  out.stdout.includes(`On branch ${branch}`);
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
  let $target = target;
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
    process.cwd(),
    'git',
    '120',
    'false',
    'object'
  ]

  const { stderr: cloneErr, stdout: cloneOut } = await exec(shArgs, state) as unknown as {stdout: string, stderr: string};
  if (cloneErr) throw new Error(cloneErr);
  if (!cloneOut.includes('Cloning into')) throw new Error(`Could not clone the repository ${repo} to ${targetPath}`);
  // Check if target folder exists
  if (!existsSync(targetPath)) {
    throw new Error(`Target folder ${targetPath} does not exist after cloning.`);
  }

  //check if .git folder exists
  const gitPath = pathModule.join(targetPath, '.git');
  if (!existsSync(gitPath)) {
    throw new Error(`.git folder does not exist after cloning.`);
  }

  try {
    // Check branch
    await checkBranch(branch, target, state);
  } catch (err) {
    // If the branch does not exist, checkout the branch
    const shArgs: ShellCommandArgs = [
      `git checkout ${branch}`,
      process.cwd(),
      'git',
      '120',
      'false',
      'object'
    ]

    await exec(shArgs, state);
    await checkBranch(branch, target, state);
  }

  // Create a .gitignore file if it does not exist
  await checkGitIgnore(targetPath, state);

  return `Successfully cloned the repository ${repo} to ${target} and checked out branch ${branch}`
};


const pullRepo = async (repo: string, target: string, branch: string, state: ChatState) => {
  // Pull the repo
  await exec([`git pull ${repo} ${branch}`], state);
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
  const { stdout: statusOut } = await exec([
    `git status`, 
    target, 
    'git', 
    '60', 
    'false', 
    'object'], state) as unknown as {stdout: string, stderr: string};
  return statusOut;
};

const commitRepo = async (target: string, commitMessage: string, state: ChatState) => {
  // Add all changes to staging area
  await exec([`git add .`,
    target,
    'git',
    '60',
    'false',
    'object'], state);
  // Commit the changes
  const { stdout, stderr } = await exec([`git commit -m "${commitMessage}"`,
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
  await exec([`git push ${repo} ${branch}`, target, 'git', '60', 'false', 'object'], state);
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

  if (!repo) return 'A request to clone a repository requires a valid repository url';
  if (!target) return 'A request to clone a repository requires a valid target path';

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
    default:
      return `Operation: ${operation} not supported. Available operations are: clone, pull, push, commit, status`;
  }
};

const GitMacroComponentDefinition: Reactory.IReactoryComponentDefinition<typeof GitMacro> = { 
  component: GitMacro,
  nameSpace: 'reactor',
  name: 'GitMacro',
  version: '1.0.0',
  description: readFileSync(require.resolve('./git.macro.md')).toString(),
  features: [{ 
    feature: 'clone',
    featureType: Reactory.FeatureType.function,
    action: ['clone', 'git', 'repository'],
    description: 'Clones a git repository',
    stem: 'clone'
  }],
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['git', 'repository', 'clone', 'pull', 'push', 'commit', 'status'],
};

export default GitMacroComponentDefinition;
