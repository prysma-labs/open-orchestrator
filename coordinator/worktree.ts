import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Orchestrator",
  GIT_AUTHOR_EMAIL: "orchestrator@localhost",
  GIT_COMMITTER_NAME: "Orchestrator",
  GIT_COMMITTER_EMAIL: "orchestrator@localhost",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, env: gitEnv });
  return `${result.stdout}${result.stderr}`.trim();
}

export async function ensureRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(repo, ["init"]);
    await writeFile(path.join(repo, "README.md"), "Workspace checkout for agent tasks.\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "Initial workspace"]);
  }
  return repo;
}

export async function addWorktree(repo: string, runId: number, role: string): Promise<{ path: string; branch: string }> {
  const branch = `orch/${runId}/${role}`;
  const worktree = path.join(path.dirname(repo), "trees", String(runId), role);
  await mkdir(path.dirname(worktree), { recursive: true });
  try {
    await git(repo, ["rev-parse", "--verify", branch]);
    await git(repo, ["worktree", "add", worktree, branch]);
  } catch {
    await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  }
  return { path: worktree, branch };
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ["add", "-A"]);
  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status) return false;
  await git(cwd, ["commit", "-m", message]);
  return true;
}

export async function integrateBranch(repo: string, branch: string): Promise<string> {
  try {
    const output = await git(repo, ["merge", "--no-ff", "--no-edit", branch]);
    return output || `Merged ${branch}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "merge failed";
    return `Could not merge ${branch}. ${message}`.slice(0, 500);
  }
}
