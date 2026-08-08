import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { ChangedFile } from "./types.js";

export const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

type GitExecutionOptions = {
  maxBuffer: number;
};

/** Injectable process boundary for Git integration tests. */
export type GitExecutor = (
  repositoryPath: string,
  args: readonly string[],
  options: GitExecutionOptions,
) => string;

export type GitDependencies = {
  execute?: GitExecutor;
};

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GitExecutableError extends GitError {}
export class GitRepositoryError extends GitError {}
export class GitReferenceError extends GitError {}
export class GitCommandError extends GitError {}

const executeGit: GitExecutor = (repositoryPath, args, { maxBuffer }) =>
  execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer,
    stdio: "pipe",
  });

function errorProperty(error: unknown, property: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[property]
    : undefined;
}

function errorOutput(error: unknown, property: "stdout" | "stderr"): string {
  const output = errorProperty(error, property);
  if (typeof output === "string") {
    return output;
  }
  return Buffer.isBuffer(output) ? output.toString("utf8") : "";
}

function isGitMissing(error: unknown): boolean {
  return errorProperty(error, "code") === "ENOENT";
}

function isNotRepositoryError(error: unknown): boolean {
  const detail = [
    error instanceof Error ? error.message : "",
    errorOutput(error, "stdout"),
    errorOutput(error, "stderr"),
  ].join("\n");
  return /not a git repository|must be run in a work tree/i.test(detail);
}

function isMissingReferenceError(error: unknown): boolean {
  return (
    errorProperty(error, "status") === 1 &&
    !errorOutput(error, "stdout").trim() &&
    !errorOutput(error, "stderr").trim()
  );
}

function runGit(
  repositoryPath: string,
  args: readonly string[],
  execute: GitExecutor,
): string {
  try {
    return execute(repositoryPath, args, { maxBuffer: GIT_MAX_BUFFER_BYTES }).trim();
  } catch (error) {
    if (isGitMissing(error)) {
      throw new GitExecutableError(
        "Git executable was not found. Install Git and ensure it is available on PATH.",
      );
    }
    throw error;
  }
}

function repositoryPathIsDirectory(repositoryPath: string): boolean {
  try {
    return statSync(repositoryPath).isDirectory();
  } catch {
    return false;
  }
}

function ensureRepository(repositoryPath: string, execute: GitExecutor): void {
  if (!repositoryPathIsDirectory(repositoryPath)) {
    throw new GitRepositoryError(
      `Repository path is not a Git repository: ${repositoryPath}. Pass a Git working tree with --repo.`,
    );
  }

  try {
    runGit(repositoryPath, ["rev-parse", "--git-dir"], execute);
  } catch (error) {
    if (error instanceof GitExecutableError) {
      throw error;
    }
    if (isNotRepositoryError(error)) {
      throw new GitRepositoryError(
        `Repository path is not a Git repository: ${repositoryPath}. Pass a Git working tree with --repo.`,
      );
    }
    throw new GitCommandError(
      `Git command failed while inspecting ${repositoryPath}. Check that the repository is accessible and retry.`,
    );
  }
}

function verifyCommit(
  repositoryPath: string,
  reference: string,
  execute: GitExecutor,
): string {
  if (reference.startsWith("-")) {
    throw new GitReferenceError(`Git base ref must not begin with "-": ${reference}.`);
  }

  try {
    const commit = runGit(
      repositoryPath,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${reference}^{commit}`],
      execute,
    );
    if (!commit) {
      throw new GitReferenceError(
        `Git base ref does not resolve to a commit: ${reference}. Pass an existing commit with --base-ref.`,
      );
    }
    return commit;
  } catch (error) {
    if (error instanceof GitError) {
      throw error;
    }
    if (isMissingReferenceError(error)) {
      throw new GitReferenceError(
        `Git base ref does not resolve to a commit: ${reference}. Pass an existing commit with --base-ref.`,
      );
    }
    throw new GitCommandError(
      `Git command failed while resolving base ref ${reference}. Check that the repository is accessible and retry.`,
    );
  }
}

function optionalCommit(
  repositoryPath: string,
  reference: string,
  execute: GitExecutor,
): string | undefined {
  try {
    return verifyCommit(repositoryPath, reference, execute);
  } catch (error) {
    if (error instanceof GitReferenceError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves an omitted base ref from the current branch upstream, then fully
 * qualified remote and local branch refs to avoid tag-name ambiguity.
 */
export function resolveBaseRef(
  repositoryPath: string,
  baseRef?: string,
  dependencies: GitDependencies = {},
): string {
  if (baseRef?.startsWith("-")) {
    throw new GitReferenceError(`Git base ref must not begin with "-": ${baseRef}.`);
  }

  const execute = dependencies.execute ?? executeGit;
  ensureRepository(repositoryPath, execute);

  if (baseRef !== undefined) {
    return verifyCommit(repositoryPath, baseRef, execute);
  }

  for (const candidate of [
    "@{u}",
    "refs/remotes/origin/HEAD",
    "refs/heads/main",
    "refs/heads/master",
  ]) {
    const commit = optionalCommit(repositoryPath, candidate, execute);
    if (commit) {
      return commit;
    }
  }

  throw new GitReferenceError(
    "Could not determine a Git base commit. Pass --base-ref <commit-ish>; no current-branch upstream, refs/remotes/origin/HEAD, refs/heads/main, or refs/heads/master resolved to a commit.",
  );
}

export function changedFiles(
  repositoryPath: string,
  baseRef?: string,
  dependencies: GitDependencies = {},
): ChangedFile[] {
  const execute = dependencies.execute ?? executeGit;
  const base = resolveBaseRef(repositoryPath, baseRef, { execute });

  let output: string;
  try {
    output = runGit(
      repositoryPath,
      ["diff", "--name-status", `${base}...HEAD`, "--"],
      execute,
    );
  } catch (error) {
    if (error instanceof GitExecutableError) {
      throw error;
    }
    throw new GitCommandError(
      `Git command failed while comparing changes in ${repositoryPath}. Check that the repository is accessible and retry.`,
    );
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [code, ...pathParts] = line.split("\t");
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      return { path: pathParts.join("\t"), status };
    });
}
