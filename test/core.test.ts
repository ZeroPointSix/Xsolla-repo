import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewRepository } from "../src/core.js";
import { markdownReport } from "../src/report.js";

const temporaryDirectories: string[] = [];

function git(repositoryPath: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repository-inspector-core-"));
  const repositoryPath = join(root, "repository");
  temporaryDirectories.push(root);
  await mkdir(repositoryPath);

  git(repositoryPath, "init", "--initial-branch=main");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test User");
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, "add", "base.txt");
  git(repositoryPath, "commit", "-m", "Initial commit");

  git(repositoryPath, "switch", "--create", "feature");
  git(repositoryPath, "mv", "base.txt", "renamed-base.txt");
  git(repositoryPath, "commit", "-m", "Rename base file");
  await writeFile(join(repositoryPath, "committed-feature.txt"), "committed\n");
  git(repositoryPath, "add", "committed-feature.txt");
  git(repositoryPath, "commit", "-m", "Feature commit");
  await writeFile(join(repositoryPath, "untracked-feature.txt"), "untracked\n");

  return repositoryPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("reviewRepository", () => {
  it("returns a format-neutral result that preserves file and validation details", async () => {
    const repositoryPath = await createRepository();
    const command =
      'node -e "process.stdout.write(\'review stdout\'); process.stderr.write(\'review stderr\')"';

    const result = await reviewRepository({
      repositoryPath,
      baseRef: "main",
      validationCommands: [command],
    });

    expect(result.changedFiles).toEqual([
      { path: "committed-feature.txt", status: "added" },
      { path: "renamed-base.txt", previousPath: "base.txt", status: "renamed" },
      { path: "untracked-feature.txt", status: "untracked" },
    ]);
    expect(result.validationResults).toEqual([
      {
        command,
        status: "passed",
        exitCode: 0,
        stdout: "review stdout",
        stderr: "review stderr",
        stdoutTruncation: {
          truncated: false,
          capturedBytes: Buffer.byteLength("review stdout"),
          omittedBytes: 0,
        },
        stderrTruncation: {
          truncated: false,
          capturedBytes: Buffer.byteLength("review stderr"),
          omittedBytes: 0,
        },
      },
    ]);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(markdownReport(result)).toContain("committed-feature.txt (added)");
    expect(markdownReport(result)).toContain("renamed: base.txt → renamed-base.txt");
    expect(markdownReport(result)).toContain("#### stdout");
  });
});
