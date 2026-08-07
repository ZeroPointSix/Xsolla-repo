import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changedFiles,
  GIT_MAX_BUFFER_BYTES,
  GitCommandError,
  GitExecutableError,
  GitReferenceError,
  GitRepositoryError,
  resolveBaseRef,
  type GitExecutor,
} from "../src/git.js";

type RepositoryFixture = {
  repositoryPath: string;
  baseCommit: string;
};

const temporaryDirectories: string[] = [];

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

async function createRepository(initialBranch: string): Promise<RepositoryFixture> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "repository-inspector-git-"));
  temporaryDirectories.push(repositoryPath);

  git(repositoryPath, "init", `--initial-branch=${initialBranch}`);
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test User");
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, "add", "base.txt");
  git(repositoryPath, "commit", "-m", "Initial commit");
  const baseCommit = git(repositoryPath, "rev-parse", "HEAD");

  git(repositoryPath, "switch", "--create", "feature");
  await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
  git(repositoryPath, "add", "feature.txt");
  git(repositoryPath, "commit", "-m", "Feature commit");

  return { repositoryPath, baseCommit };
}

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-inspector-non-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Git base resolution", () => {
  it("uses the current branch upstream before other default candidates", async () => {
    const fixture = await createRepository("trunk");
    git(fixture.repositoryPath, "config", "branch.feature.remote", ".");
    git(fixture.repositoryPath, "config", "branch.feature.merge", "refs/heads/trunk");

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
    expect(changedFiles(fixture.repositoryPath)).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
  });

  it("uses origin/HEAD when the current branch has no upstream", async () => {
    const fixture = await createRepository("trunk");
    git(fixture.repositoryPath, "remote", "add", "origin", "https://example.invalid/repository.git");
    git(fixture.repositoryPath, "update-ref", "refs/remotes/origin/HEAD", fixture.baseCommit);

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
  });

  it("falls back to local master in a standalone repository", async () => {
    const fixture = await createRepository("master");

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
    expect(changedFiles(fixture.repositoryPath)).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
  });

  it("requires an explicit base ref when no default candidate resolves", async () => {
    const fixture = await createRepository("trunk");

    expect(() => resolveBaseRef(fixture.repositoryPath)).toThrow(GitReferenceError);
    expect(() => resolveBaseRef(fixture.repositoryPath)).toThrow("--base-ref <commit-ish>");
  });

  it("reports a non-Git directory with an actionable error", async () => {
    const directory = await createDirectory();

    expect(() => changedFiles(directory)).toThrow(GitRepositoryError);
    expect(() => changedFiles(directory)).toThrow("not a Git repository");
  });

  it("reports an explicit ref that does not exist", async () => {
    const fixture = await createRepository("main");

    expect(() => changedFiles(fixture.repositoryPath, "missing-ref")).toThrow(
      GitReferenceError,
    );
    expect(() => changedFiles(fixture.repositoryPath, "missing-ref")).toThrow(
      "does not resolve to a commit",
    );
  });

  it("rejects an option-like explicit ref before invoking Git", async () => {
    const fixture = await createRepository("main");
    const execute = vi.fn<GitExecutor>();

    expect(() => changedFiles(fixture.repositoryPath, "-cfoo.bar=true", { execute })).toThrow(
      'Git base ref must not begin with "-"',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a missing Git executable through the injected process boundary", async () => {
    const fixture = await createRepository("main");
    const execute: GitExecutor = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };

    expect(() => changedFiles(fixture.repositoryPath, "HEAD", { execute })).toThrow(
      GitExecutableError,
    );
    expect(() => changedFiles(fixture.repositoryPath, "HEAD", { execute })).toThrow(
      "Install Git and ensure it is available on PATH",
    );
  });

  it("uses end-of-options commit verification, a bounded buffer, and a diff separator", async () => {
    const fixture = await createRepository("main");
    const calls: string[][] = [];
    const buffers: number[] = [];
    const execute: GitExecutor = (_repositoryPath, args, options) => {
      calls.push([...args]);
      buffers.push(options.maxBuffer);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") {
        return ".git";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "base-commit";
      }
      if (args[0] === "diff") {
        return "A\tfeature.txt\n";
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
    expect(calls).toEqual([
      ["rev-parse", "--git-dir"],
      ["rev-parse", "--verify", "--quiet", "--end-of-options", "topic^{commit}"],
      ["diff", "--name-status", "base-commit...HEAD", "--"],
    ]);
    expect(buffers).toEqual([GIT_MAX_BUFFER_BYTES, GIT_MAX_BUFFER_BYTES, GIT_MAX_BUFFER_BYTES]);
  });

  it("normalizes an unexpected Git command failure", async () => {
    const fixture = await createRepository("main");
    const execute: GitExecutor = () => {
      throw new Error("unexpected process failure");
    };

    expect(() => changedFiles(fixture.repositoryPath, "HEAD", { execute })).toThrow(
      GitCommandError,
    );
    expect(() => changedFiles(fixture.repositoryPath, "HEAD", { execute })).toThrow(
      "while inspecting",
    );
  });
});
