import pathModule from "path";
import os from "os";
import { promises as fs, readFileSync, existsSync, mkdirSync } from "fs";
import {
  ChatState,
  Macro,
  MacroComponentDefinition,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { DeleteDirectory } from "../../fs/macro";
import { ShellCommand } from "../../shell/macro";
import { template } from "lodash";
import { ShellCommandProps } from "../../shell/types";
import Reactory from "@reactory/reactory-core";
import { GitMacroArgs } from "./types";

/**
 * A function that checks if the git ignore file exists
 * if not it creates one
 */
const checkGitIgnore = async (target: string, state: ChatState) => {
  // Create a .gitignore file if it does not exist
  const shArgs: ShellCommandProps = {
    command: `git add .gitignore`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "5",
    sudo: "false",
    format: "string",
  };

  const gitIgnorePath = pathModule.join(target, ".gitignore");
  if (!existsSync(gitIgnorePath)) {
    await fs.writeFile(gitIgnorePath, "");
    // Add .gitignore to staging area

    await ShellCommand(shArgs, state);
    // Commit the changes
    shArgs.command = `git commit -m "Add .gitignore"`;
    await ShellCommand(shArgs, state);
  }
};

/**
 * Checks out a git branch if it exists
 * @param branch - the branch to checkout
 * @param target - the target folder
 * @param state - the current chat state
 * @returns
 */
const checkoutBranch = async (
  branch: string,
  target: string,
  state: ChatState
) => {
  // Checkout the branch
  const shArgs: ShellCommandProps = {
    command: `git checkout ${branch}`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "5",
    sudo: "false",
    format: "string",
  };

  await ShellCommand(shArgs, state);
  return checkBranch(branch, target, state);
};

/**
 * Checks a git branch
 * @param branch
 * @param target
 */
const checkBranch = async (
  branch: string,
  target: string,
  state: ChatState
) => {
  // Check git status
  const result = await ShellCommand(
    {
      command: `git status`,
      workingDir: target,
      templateId: "git",
      timeoutInSeconds: "5",
      sudo: "false",
      format: "object",
    },
    state
  );
  
  // Ensure branch specification and output match
  if (result.error) {
    throw new Error(result.error);
  }

  const stdout = result.data?.stdout || "";
  const isOnCorrectBranch = stdout?.includes(`On branch ${branch}`) || false;
  if (!isOnCorrectBranch) {
    throw new Error(
      `Current branch does not match the specified branch ${branch}.`
    );
  }
  return `${branch} is the current branch`;
};

/**
 * Clones a repo
 * @param repo
 * @param target
 * @param branch
 */
const cloneRepo = async (
  repo: string,
  target: string,
  branch: string,
  overwrite: boolean = false,
  state: ChatState
): Promise<string> => {
  //check if the target folder contains the repo name already
  const repoName = repo.split("/").pop().replace(".git", "");
  let $target = target; //$target is the target folder
  if ($target.endsWith(repoName)) {
    $target = $target.replace(repoName, "");
  }

  const targetPath = pathModule.join($target, repoName);
  //check if the target folder exists and create it if it does not
  if (!existsSync(targetPath)) {
    mkdirSync(targetPath, { recursive: true });
  } else {
    //check if the target folder exists and whether to overwrite it
    if (existsSync($target) === true && overwrite === false)
      throw new Error(
        `Target folder ${targetPath} already exists. Use overwrite flag to overwrite the folder.`
      );
    if (existsSync($target) === true && overwrite === true)
      await DeleteDirectory({ paths: [$target] }, state);
  }
  // Clone the repo
  let shArgs: ShellCommandProps = {
    command: `git clone ${repo} ${targetPath} --branch ${branch}`,
    workingDir: targetPath,
    templateId: "git",
    timeoutInSeconds: "120",
    sudo: "false",
    format: "object",
  };

  const result = await ShellCommand(shArgs, state);
  if (result.error) {
    throw new Error(result.error);
  }

  const cloneOut = result.data?.stdout || "";
  if (cloneOut && !cloneOut?.includes("Cloning into"))
    throw new Error(`Could not clone the repository ${repo} to ${targetPath}`);
  // Check if target folder exists
  if (!existsSync(targetPath)) {
    throw new Error(
      `Target folder ${targetPath} does not exist after cloning.`
    );
  }

  //check if .git folder exists
  const gitPath = pathModule.join(targetPath, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`.git folder does not exist after cloning.`);
  }

  return `Successfully cloned the repository ${repo} to ${targetPath} and checked out branch ${branch}`;
};

const pullRepo = async (
  repo: string,
  target: string,
  branch: string,
  state: ChatState
) => {
  // Pull the repo
  await ShellCommand({
    command: `git pull ${repo} ${branch}`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "60",
    sudo: "false",
    format: "object",
  }, state);
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
  const result = await ShellCommand({
    command: `git status`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "60",
    sudo: "false",
    format: "object",
  }, state);

  if (result.error) throw new Error(result.error);
  return result.data?.stdout || "";
};

const commitRepo = async (
  target: string,
  commitMessage: string,
  state: ChatState
) => {
  // Add all changes to staging area
  await ShellCommand({
    command: `git add .`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "60",
    sudo: "false",
    format: "object",
  }, state);
  // Commit the changes
  const result = await ShellCommand({
    command: `git commit -m "${commitMessage}"`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "60",
    sudo: "false",
    format: "object",
  }, state);

  if (result.error) throw new Error(result.error);
  const stdout = result.data?.stdout || "";
  if (!stdout.includes("file changed"))
    throw new Error(
      `Could not commit changes to the repository at ${target} with message "${commitMessage}"`
    );
};

const pushRepo = async (
  repo: string,
  target: string,
  branch: string,
  state: ChatState
) => {
  // Push the commit to the repo
  await ShellCommand({
    command: `git push ${repo} ${branch}`,
    workingDir: target,
    templateId: "git",
    timeoutInSeconds: "60",
    sudo: "false",
    format: "object",
  }, state);
};

/**
 * A macro that will perform git operations
 * @param args
 * @param state
 * @returns
 */
export const GitMacro: Macro<string> = async (
  args: GitMacroArgs,
  state: ChatState
) => {
  const [operation, ...options] = args;

  let [repo, target, branch = "master", overwrite = "false"] = options;

  if (!repo && operation === "clone")
    return "A request to clone a repository requires a valid repository url";
  if (!target) return "A git request requires a target folder";

  if (repo.indexOf("${") > -1)
    repo = template(repo)({ os, pathModule, process, state });
  if (target.indexOf("${") > -1)
    target = template(target)({ os, pathModule, process, state });
  if (branch.indexOf("${") > -1)
    branch = template(branch)({ os, pathModule, process, state });

  switch (operation) {
    case "clone":
      try {
        return await cloneRepo(
          repo,
          target,
          branch,
          overwrite === "true",
          state
        );
      } catch (err) {
        return `Could not clone the repository due to an error ${err.message}`;
      }
    case "pull":
      try {
        await pullRepo(repo, target, branch, state);
        return `Successfully pulled the repository ${repo} from branch ${branch} to ${target}`;
      } catch (err) {
        return `Could not pull the repository due to an error ${err.message}`;
      }
    case "commit":
      const commitMessage = "your commit message"; // replace with actual commit message
      try {
        await commitRepo(target, commitMessage, state);
        return `Successfully committed changes to the repository at ${target} with message "${commitMessage}"`;
      } catch (err) {
        return `Could not commit changes due to an error ${err.message}`;
      }

    case "push":
      try {
        await pushRepo(repo, target, branch, state);
        return `Successfully pushed changes to the repository ${repo} on branch ${branch} from ${target}`;
      } catch (err) {
        return `Could not push changes due to an error ${err.message}`;
      }
    case "status":
      try {
        const status = await gitStatus(target, state);
        return status;
      } catch (err) {
        return `Could not retrieve git status due to an error ${err.message}`;
      }
    case "checkout": {
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

const GitMacroComponentDefinition: MacroComponentDefinition<typeof GitMacro> = {
  component: GitMacro,
  nameSpace: "reactor",
  name: "GitMacro",
  version: "1.0.0",
  description: readFileSync(require.resolve("./readme.md")).toString(),
  features: [
    {
      feature: "clone",
      featureType: Reactory.FeatureType.function,
      action: ["clone", "git", "repository"],
      description: "Clones a git repository",
      stem: "clone",
    },
  ],
  roles: ["DEVELOPER", "ADMIN"],
  tags: [
    "git",
    "repository",
    "clone",
    "pull",
    "push",
    "commit",
    "status",
    "checkout",
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "clone",
        description: "Clone a git repository to a target directory",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "The URL of the git repository to clone",
            },
            target: {
              type: "string",
              description: "The target folder to clone the repository to",
            },
            branch: {
              type: "string",
              description: "The branch to checkout (default: master)",
            },
            overwrite: {
              type: "boolean",
              description: "Whether to overwrite existing directory",
            },
          },
          required: ["repo", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "pull",
        description: "Pull latest changes from a git repository",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "The URL of the git repository to pull from",
            },
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
            branch: {
              type: "string",
              description: "The branch to pull from (default: master)",
            },
          },
          required: ["repo", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "push",
        description: "Push changes to a git repository",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "The URL of the git repository to push to",
            },
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
            branch: {
              type: "string",
              description: "The branch to push to (default: master)",
            },
          },
          required: ["repo", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "commit",
        description: "Commit changes to a git repository",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
            commitMessage: {
              type: "string",
              description: "The commit message to use",
            },
          },
          required: ["target", "commitMessage"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "status",
        description: "Get the status of a git repository",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
          },
          required: ["target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkout",
        description: "Checkout a git branch",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
            branch: {
              type: "string",
              description: "The branch to checkout",
            },
          },
          required: ["target", "branch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add",
        description: "Add files to git staging area",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The target folder containing the repository",
            },
            file: {
              type: "string",
              description: "The file or pattern to add to staging",
            },
          },
          required: ["target", "file"],
        },
      },
    },
  ],
};

export default GitMacroComponentDefinition;
