import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewRepository } from "../src/core.js";

const temporaryDirectories: string[] = [];

function git(repositoryPath: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
}

async function createCoreFlowRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "repository-inspector-core-flow-"));
  temporaryDirectories.push(repositoryPath);

  git(repositoryPath, "init", "--initial-branch=main");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test User");
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, "add", "base.txt");
  git(repositoryPath, "commit", "-m", "Base commit");

  git(repositoryPath, "switch", "--create", "feature");
  await writeFile(join(repositoryPath, "committed-feature.txt"), "committed\n");
  git(repositoryPath, "add", "committed-feature.txt");
  git(repositoryPath, "commit", "-m", "Feature commit");
  await writeFile(join(repositoryPath, "current-untracked.txt"), "untracked\n");

  return repositoryPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("reviewRepository core flow", () => {
  it("returns committed and current worktree changes with a shellless validation result", async () => {
    const repositoryPath = await createCoreFlowRepository();
    const command = `node -e "process.stdout.write('core flow validation')"`;

    const result = await reviewRepository({
      repositoryPath,
      baseRef: "main",
      validationCommands: [command],
    });

    expect(result).toEqual({
      repositoryPath,
      changedFiles: [
        { path: "committed-feature.txt", status: "added" },
        { path: "current-untracked.txt", status: "untracked" },
      ],
      validationResults: [
        {
          command,
          status: "passed",
          exitCode: 0,
          stdout: "core flow validation",
          stderr: "",
          stdoutTruncation: {
            truncated: false,
            capturedBytes: Buffer.byteLength("core flow validation"),
            omittedBytes: 0,
          },
          stderrTruncation: { truncated: false, capturedBytes: 0, omittedBytes: 0 },
        },
      ],
    });
  });
});
