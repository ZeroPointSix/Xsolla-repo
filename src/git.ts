import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ChangedFile, ChangedFileStatus, RepositoryInspection } from "./types.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export class GitInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInspectionError";
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error ? (error as { stderr?: Buffer | string }).stderr : undefined;
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8").trim();
  if (typeof stderr === "string") return stderr.trim();
  return error.message;
}

function git(repositoryPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = errorText(error);
    if (detail.includes("ENOENT") || detail.includes("spawnSync git ENOENT")) {
      throw new GitInspectionError("Git is not installed or is not available on PATH.");
    }
    throw new GitInspectionError(detail || "Git command failed without an error message.");
  }
}

function tryGit(repositoryPath: string, args: string[]): string | undefined {
  try {
    return git(repositoryPath, args).trim();
  } catch {
    return undefined;
  }
}

function canonicalRepositoryPath(repositoryPath: string): string {
  try {
    const canonical = realpathSync(repositoryPath);
    if (!statSync(canonical).isDirectory()) {
      throw new GitInspectionError(`Repository path is not a directory: ${repositoryPath}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    throw new GitInspectionError(`Repository path does not exist: ${repositoryPath}`);
  }
}

function validateRepository(repositoryPath: string): void {
  try {
    if (git(repositoryPath, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      throw new Error("outside work tree");
    }
  } catch (error) {
    if (error instanceof GitInspectionError && error.message.startsWith("Git is not installed")) {
      throw error;
    }
    throw new GitInspectionError(`Path is not a Git repository: ${repositoryPath}`);
  }
}

function verifiedRef(repositoryPath: string, ref: string): string | undefined {
  if (ref.startsWith("-")) return undefined;
  return tryGit(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

function resolveBaseRef(
  repositoryPath: string,
  requestedRef?: string,
): { label: string; commit: string } {
  if (requestedRef?.startsWith("-")) {
    throw new GitInspectionError("Base ref must not start with '-'.");
  }

  if (requestedRef) {
    const commit = verifiedRef(repositoryPath, requestedRef);
    if (!commit) {
      throw new GitInspectionError(
        `Base ref '${requestedRef}' does not exist. Pass a valid branch, tag, or commit.`,
      );
    }
    return { label: requestedRef, commit };
  }

  const candidates: string[] = [];
  const upstream = tryGit(repositoryPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream) candidates.push(upstream);

  const remoteHead = tryGit(repositoryPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) candidates.push(remoteHead);
  candidates.push("main", "master");

  for (const candidate of [...new Set(candidates)]) {
    const commit = verifiedRef(repositoryPath, candidate);
    if (commit) return { label: candidate, commit };
  }

  throw new GitInspectionError(
    "Could not detect a base ref. Pass one explicitly with --base-ref.",
  );
}

function statusFromCode(code: string): ChangedFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++];
    const status = statusFromCode(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath === undefined || path === undefined) {
        throw new GitInspectionError("Git returned an incomplete rename or copy record.");
      }
      files.push({ path, previousPath, status });
      continue;
    }

    const path = fields[index++];
    if (path === undefined) {
      throw new GitInspectionError("Git returned an incomplete file status record.");
    }
    files.push({ path, status });
  }
  return files;
}

function mergeFiles(groups: ChangedFile[][]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const priority: Record<ChangedFileStatus, number> = {
    conflicted: 8,
    renamed: 7,
    copied: 6,
    deleted: 5,
    added: 4,
    untracked: 4,
    "type-changed": 3,
    modified: 2,
  };

  for (const group of groups) {
    for (const file of group) {
      const existing = files.get(file.path);
      if (!existing || priority[file.status] > priority[existing.status]) {
        files.set(file.path, file);
      }
    }
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function inspectRepository(
  repositoryPath: string,
  requestedBaseRef?: string,
): RepositoryInspection {
  const canonicalPath = canonicalRepositoryPath(repositoryPath);
  validateRepository(canonicalPath);
  const base = resolveBaseRef(canonicalPath, requestedBaseRef);
  const mergeBase = tryGit(canonicalPath, ["merge-base", base.commit, "HEAD"]);
  const comparisonCommit = mergeBase || base.commit;

  const diffArgs = ["--name-status", "-z", "--find-renames", "--find-copies"];
  const committed = parseNameStatus(
    git(canonicalPath, ["diff", ...diffArgs, `${comparisonCommit}..HEAD`, "--"]),
  );
  const staged = parseNameStatus(
    git(canonicalPath, ["diff", "--cached", ...diffArgs, "--"]),
  );
  const unstaged = parseNameStatus(git(canonicalPath, ["diff", ...diffArgs, "--"]));
  const untracked = git(canonicalPath, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((path): ChangedFile => ({ path, status: "untracked" }));

  return {
    name: basename(canonicalPath),
    path: canonicalPath,
    baseRef: base.label,
    changedFiles: mergeFiles([committed, staged, unstaged, untracked]),
  };
}
