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
  GitNameStatusParseError,
  GitReferenceError,
  GitRepositoryError,
  parseNameStatusNul,
  resolveBaseRef,
  type GitExecutor,
} from "../src/git.js";
import {
  completeNameStatusOutput,
  malformedNameStatusOutputs,
  malformedStatusPrefixes,
} from "./fixtures/git-name-status.js";

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

describe("NUL-delimited Git name-status parsing", () => {
  it("preserves Unicode, tab, and newline paths for all supported statuses", () => {
    expect(parseNameStatusNul(completeNameStatusOutput)).toEqual([
      { path: "src/中文 file.ts", status: "added" },
      { path: "deleted file.ts", status: "deleted" },
      { path: "src/literal\tname.ts", status: "modified" },
      {
        path: "renames/new\n中文 name.ts",
        previousPath: "renames/old\tname.ts",
        status: "renamed",
      },
      {
        path: "copies/destination\tfile.ts",
        previousPath: "copies/source\nfile.ts",
        status: "copied",
      },
      { path: "links/changed target", status: "type_changed" },
      { path: "conflicts/unmerged file.ts", status: "unmerged" },
    ]);
  });

  it("returns no changes for a complete empty stream", () => {
    expect(parseNameStatusNul("")).toEqual([]);
  });

  it("fails closed with a typed error for malformed records", () => {
    for (const output of Object.values(malformedNameStatusOutputs)) {
      expect(() => parseNameStatusNul(output)).toThrow(GitNameStatusParseError);
    }
  });

  it("does not treat a status token as a recovered path after misalignment", () => {
    expect(() => parseNameStatusNul("M\0A\0recovered.ts\0")).toThrow(
      GitNameStatusParseError,
    );
  });

  it("fails closed for fuzzed malformed prefixes instead of recovering later records", () => {
    let state = 0x5eed1234;
    const next = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const status = malformedStatusPrefixes[next() % malformedStatusPrefixes.length]!;
      const output = [status, `invalid-${iteration}.ts`, "A", `recovered-${iteration}.ts`].join(
        "\0",
      ) + "\0";

      expect(() => parseNameStatusNul(output)).toThrow(GitNameStatusParseError);
    }
  });
});

describe("Git base resolution", () => {
  it("uses the current branch upstream instead of a tag named trunk", async () => {
    const fixture = await createRepository("trunk");
    git(fixture.repositoryPath, "config", "branch.feature.remote", ".");
    git(fixture.repositoryPath, "config", "branch.feature.merge", "refs/heads/trunk");
    git(fixture.repositoryPath, "tag", "trunk", "HEAD");

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
    expect(changedFiles(fixture.repositoryPath)).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
  });

  it("detects copies from unchanged tracked sources", async () => {
    const fixture = await createRepository("main");
    await writeFile(join(fixture.repositoryPath, "copied-base.txt"), "base\n");
    git(fixture.repositoryPath, "add", "copied-base.txt");
    git(fixture.repositoryPath, "commit", "-m", "Copy unchanged base file");

    expect(changedFiles(fixture.repositoryPath, fixture.baseCommit)).toContainEqual({
      path: "copied-base.txt",
      previousPath: "base.txt",
      status: "copied",
    });
  });

  it("uses refs/remotes/origin/HEAD instead of a tag named origin/HEAD", async () => {
    const fixture = await createRepository("trunk");
    git(fixture.repositoryPath, "remote", "add", "origin", "https://example.invalid/repository.git");
    git(fixture.repositoryPath, "update-ref", "refs/remotes/origin/HEAD", fixture.baseCommit);
    git(fixture.repositoryPath, "tag", "origin/HEAD", "HEAD");

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
    expect(changedFiles(fixture.repositoryPath)).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
  });

  it("uses refs/heads/main instead of a tag named main", async () => {
    const fixture = await createRepository("main");
    git(fixture.repositoryPath, "tag", "main", "HEAD");

    expect(resolveBaseRef(fixture.repositoryPath)).toBe(fixture.baseCommit);
    expect(changedFiles(fixture.repositoryPath)).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
  });

  it("uses refs/heads/master instead of a tag named master", async () => {
    const fixture = await createRepository("master");
    git(fixture.repositoryPath, "tag", "master", "HEAD");

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
        return "A\0feature.txt\0";
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      { path: "feature.txt", status: "added" },
    ]);
    expect(calls).toEqual([
      ["rev-parse", "--git-dir"],
      ["rev-parse", "--verify", "--quiet", "--end-of-options", "topic^{commit}"],
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "base-commit...HEAD",
        "--",
      ],
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
