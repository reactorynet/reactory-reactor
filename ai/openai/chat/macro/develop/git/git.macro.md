# Git Macro

The GitMacro is a macro that enables users to perform Git operations in a chat context.

## Usage
The syntax for using the GitMacro is as follows: 

`@git(operation, repo, target, branch, overwrite?)`

- `operation`: the Git operation to perform. Available operations are: clone, pull, push, commit, status, and checkout.
- `repo`: the repository url or the path to the repository (if it's a local repo)
- `target`: the target folder for the operation
- `branch`: (optional) the name of the Git branch to use. Default value is `master`.
- `overwrite`: (optional) flag indicating whether to overwrite the target folder if it already exists. Default value is `false`. 

### Examples

- `@git(clone, https://github.com/myorg/myrepo.git, /home/user/myrepo)`
  This clones the `https://github.com/myorg/myrepo.git` repository to the `/home/user/myrepo` folder.

- `@git(pull, /home/user/myrepo, test-branch)`
  This pulls the changes from the `test-branch` branch of the repository located in the `/home/user/myrepo` folder.

- `@git(commit, /home/user/myrepo, "This is my commit message")`
  This commits changes to the repository located in the `/home/user/myrepo` folder with the specified commit message.

- `@git(push, https://github.com/myorg/myrepo.git, /home/user/myrepo)`
  This pushes changes to the `https://github.com/myorg/myrepo.git` repository from the `/home/user/myrepo` folder.

- `@git(checkout, /home/user/myrepo, test-branch)`
  This checks out the `test-branch` branch of the repository located in the `/home/user/myrepo` folder.

- `@git(status, /home/user/myrepo)`
  This gets the Git status of the repository located in the `/home/user/myrepo` folder.

## Features

The GitMacro supports the following Git operations:
- `clone`: Clones a repository.
- `pull`: Pulls changes from a repository.
- `push`: Pushes changes to a repository.
- `commit`: Commits changes to a repository.
- `status`: Gets the Git status of a repository.
- `checkout`: Checks out a Git branch.

## Roles

The GitMacro is available to users with the `DEVELOPER` and `ADMIN` roles.

## Tags

The GitMacro is tagged with the following keywords:
- git
- repository
- clone
- pull
- push
- commit
- status
- checkout

## Examples

A sample usage of the GitMacro is as follows:

```
@git(clone, https://github.com/myorg/myrepo.git, /home/user/myrepo)
```
This clones the `https://github.com/myorg/myrepo.git` repository to the `/home/user/myrepo` folder.
