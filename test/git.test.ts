import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  parseUntrackedPorcelainNul,
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
  await writeFile(join(repositoryPath, "duplicate path.txt"), "base duplicate\n");
  await writeFile(join(repositoryPath, "unstaged file.txt"), "base unstaged\n");
  await writeFile(join(repositoryPath, ".gitignore"), "ignored file.txt\nignored/\n");
  git(repositoryPath, "add", "base.txt", "duplicate path.txt", "unstaged file.txt", ".gitignore");
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

type GitDiffLayers = {
  committed?: string;
  staged?: string;
  unstaged?: string;
  status?: string;
};

function executeGitDiffLayers({
  committed = "",
  staged = "",
  unstaged = "",
  status = "",
}: GitDiffLayers): GitExecutor {
  return (_repositoryPath, args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      return ".git";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return "base-commit";
    }
    if (args[0] === "diff" && args.includes("base-commit...HEAD")) {
      return committed;
    }
    if (args[0] === "diff" && args.includes("--cached")) {
      return staged;
    }
    if (args[0] === "diff") {
      return unstaged;
    }
    if (args[0] === "status") {
      return status;
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
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

  it("extracts only untracked paths from porcelain records without splitting paths", () => {
    const output = [
      " M tracked file.txt",
      "R  renamed destination.txt",
      "?? source path that must be skipped.txt",
      "?? 未跟踪 space file.txt",
      "!! ignored file.txt",
    ].join("\0") + "\0";

    expect(parseUntrackedPorcelainNul(output)).toEqual([
      { path: "未跟踪 space file.txt", status: "untracked" },
    ]);
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

  it("detects a staged copy from an unchanged tracked source", async () => {
    const fixture = await createRepository("main");
    await writeFile(join(fixture.repositoryPath, "staged-copy.txt"), "base\n");
    git(fixture.repositoryPath, "add", "staged-copy.txt");

    expect(changedFiles(fixture.repositoryPath, fixture.baseCommit)).toContainEqual({
      path: "staged-copy.txt",
      previousPath: "base.txt",
      status: "copied",
    });
  });

  it("combines committed and local changes into a sorted complete review view", async () => {
    const fixture = await createRepository("main");

    await writeFile(join(fixture.repositoryPath, "committed 中文 file.txt"), "committed\n");
    git(fixture.repositoryPath, "add", "committed 中文 file.txt");
    git(fixture.repositoryPath, "rm", "--", "duplicate path.txt");
    git(fixture.repositoryPath, "commit", "-m", "Committed review changes");

    await writeFile(join(fixture.repositoryPath, "duplicate path.txt"), "staged duplicate\n");
    await writeFile(join(fixture.repositoryPath, "staged file.txt"), "staged\n");
    git(fixture.repositoryPath, "add", "duplicate path.txt", "staged file.txt");

    await writeFile(join(fixture.repositoryPath, "duplicate path.txt"), "unstaged duplicate\n");
    await writeFile(join(fixture.repositoryPath, "unstaged file.txt"), "unstaged\n");
    await writeFile(join(fixture.repositoryPath, "未跟踪 space file.txt"), "untracked\n");
    await writeFile(join(fixture.repositoryPath, "ignored file.txt"), "ignored\n");
    await mkdir(join(fixture.repositoryPath, "ignored"));
    await writeFile(join(fixture.repositoryPath, "ignored", "nested file.txt"), "ignored\n");

    const expected = [
      { path: "committed 中文 file.txt", status: "added" as const },
      { path: "duplicate path.txt", status: "modified" as const },
      { path: "feature.txt", status: "added" as const },
      { path: "staged file.txt", status: "added" as const },
      { path: "unstaged file.txt", status: "modified" as const },
      { path: "未跟踪 space file.txt", status: "untracked" as const },
    ];

    expect(changedFiles(fixture.repositoryPath, fixture.baseCommit)).toEqual(expected);
    expect(changedFiles(fixture.repositoryPath, fixture.baseCommit)).toEqual(expected);
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

  it("uses NUL-safe Git commands with end-of-options and a bounded buffer", async () => {
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
      if (args[0] === "diff" && args.includes("base-commit...HEAD")) {
        return "A\0feature.txt\0";
      }
      if (args[0] === "diff" && args.includes("--cached")) {
        return "M\0feature.txt\0";
      }
      if (args[0] === "diff") {
        return "T\0feature.txt\0";
      }
      if (args[0] === "status") {
        return "?? untracked file.txt\0";
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      { path: "feature.txt", status: "type_changed" },
      { path: "untracked file.txt", status: "untracked" },
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
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "--cached",
        "--",
      ],
      ["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--"],
    ]);
    expect(buffers).toEqual(Array(6).fill(GIT_MAX_BUFFER_BYTES));
  });

  it("preserves effective rename and copy source paths while applying precedence", async () => {
    const fixture = await createRepository("main");
    const execute: GitExecutor = (_repositoryPath, args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") {
        return ".git";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "base-commit";
      }
      if (args[0] === "diff" && args.includes("base-commit...HEAD")) {
        return [
          "R100",
          "committed old.txt",
          "committed renamed.txt",
          "C100",
          "copy source.txt",
          "copy destination.txt",
          "A",
          "overridden.txt",
        ].join("\0") + "\0";
      }
      if (args[0] === "diff" && args.includes("--cached")) {
        return ["C100", "staged source.txt", "staged copy.txt"].join("\0") + "\0";
      }
      if (args[0] === "diff") {
        return "M\0overridden.txt\0";
      }
      if (args[0] === "status") {
        return "?? overridden.txt\0?? untracked file.txt\0";
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      {
        path: "committed renamed.txt",
        previousPath: "committed old.txt",
        status: "renamed",
      },
      {
        path: "copy destination.txt",
        previousPath: "copy source.txt",
        status: "copied",
      },
      { path: "overridden.txt", status: "modified" },
      {
        path: "staged copy.txt",
        previousPath: "staged source.txt",
        status: "copied",
      },
      { path: "untracked file.txt", status: "untracked" },
    ]);
  });

  it("composes a committed-to-staged rename chain into one final current path", async () => {
    const fixture = await createRepository("main");
    const execute = executeGitDiffLayers({
      committed: ["R100", "original.txt", "intermediate.txt"].join("\0") + "\0",
      staged: ["R100", "intermediate.txt", "final.txt"].join("\0") + "\0",
    });

    const expected = [
      { path: "final.txt", previousPath: "original.txt", status: "renamed" as const },
    ];

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual(expected);
    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual(expected);
  });

  it("composes a staged-to-unstaged rename chain into one final current path", async () => {
    const fixture = await createRepository("main");
    const execute = executeGitDiffLayers({
      staged: ["R100", "original.txt", "staged.txt"].join("\0") + "\0",
      unstaged: ["R100", "staged.txt", "final.txt"].join("\0") + "\0",
    });

    const expected = [
      { path: "final.txt", previousPath: "original.txt", status: "renamed" as const },
    ];

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual(expected);
    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual(expected);
  });

  it("keeps an effective copy source while composing its destination rename", async () => {
    const fixture = await createRepository("main");
    const execute = executeGitDiffLayers({
      committed:
        [
          "M",
          "copy source.txt",
          "C100",
          "copy source.txt",
          "copy destination.txt",
        ].join("\0") + "\0",
      staged: ["R100", "copy destination.txt", "renamed copy.txt"].join("\0") + "\0",
    });

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      { path: "copy source.txt", status: "modified" },
      {
        path: "renamed copy.txt",
        previousPath: "copy source.txt",
        status: "copied",
      },
    ]);
  });

  it("lets untracked files replace committed and staged deletions at the same path", async () => {
    const fixture = await createRepository("main");
    const execute = executeGitDiffLayers({
      committed: ["D", "committed-recreated.txt"].join("\0") + "\0",
      staged: ["D", "staged-recreated.txt"].join("\0") + "\0",
      status: ["?? committed-recreated.txt", "?? staged-recreated.txt"].join("\0") + "\0",
    });

    expect(changedFiles(fixture.repositoryPath, "topic", { execute })).toEqual([
      { path: "committed-recreated.txt", status: "untracked" },
      { path: "staged-recreated.txt", status: "untracked" },
    ]);
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
