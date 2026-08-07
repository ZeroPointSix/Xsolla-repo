import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const tsxLoaderPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, ["--import", tsxLoaderPath, cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function git(repositoryPath: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repository-inspector-cli-"));
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
  await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
  git(repositoryPath, "add", "feature.txt");
  git(repositoryPath, "commit", "-m", "Feature commit");

  return repositoryPath;
}

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-inspector-output-"));
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

describe("CLI", () => {
  it.each([
    [["--help"], "Usage: inspector review"],
    [["review", "--help"], "Usage: inspector review"],
    [["--version"], "2.0.0"],
    [["review", "--version"], "2.0.0"],
  ])("exits successfully for %j without --repo", (args, expectedOutput) => {
    const result = runCli(args);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
    expect(result.stderr).toBe("");
  });

  it("exits nonzero for usage errors", () => {
    const result = runCli(["review", "--repo", "--base-ref", "main"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--repo requires a value.");
    expect(result.stderr).toContain("Usage: inspector review");
  });

  it("writes the default Markdown report to the invoking directory", async () => {
    const repositoryPath = await createRepository();
    const outputDirectory = await createOutputDirectory();
    const command = `node -e "process.stdout.write('Markdown validation')"`;

    const result = runCli(
      [
        "review",
        "--repo",
        repositoryPath,
        "--base-ref",
        "main",
        "--validate",
        command,
      ],
      outputDirectory,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Review report written to review-report.md\n");
    expect(result.stderr).toBe("");
    expect(existsSync(join(outputDirectory, "review-report.json"))).toBe(false);

    const report = await readFile(join(outputDirectory, "review-report.md"), "utf8");
    expect(report).toContain("# Review Report:");
    expect(report).toContain("feature.txt (added)");
    expect(report).toContain("Markdown validation");
  });

  it("writes parseable JSON without also emitting a Markdown report", async () => {
    const repositoryPath = await createRepository();
    const outputDirectory = await createOutputDirectory();
    const command =
      `node -e "process.stdout.write('JSON validation'); process.stderr.write('JSON diagnostic')"`;

    const result = runCli(
      [
        "review",
        "--repo",
        repositoryPath,
        "--base-ref",
        "main",
        "--format",
        "json",
        "--validate",
        command,
      ],
      outputDirectory,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Review report written to review-report.json\n");
    expect(result.stderr).toBe("");
    expect(existsSync(join(outputDirectory, "review-report.md"))).toBe(false);

    const report = JSON.parse(
      await readFile(join(outputDirectory, "review-report.json"), "utf8"),
    ) as unknown;
    expect(report).toMatchObject({
      repositoryPath,
      changedFiles: [{ path: "feature.txt", status: "added" }],
      validationResults: [
        {
          command,
          status: "passed",
          exitCode: 0,
          stdout: "JSON validation",
          stderr: "JSON diagnostic",
          stdoutTruncation: {
            truncated: false,
            capturedBytes: Buffer.byteLength("JSON validation"),
            omittedBytes: 0,
          },
          stderrTruncation: {
            truncated: false,
            capturedBytes: Buffer.byteLength("JSON diagnostic"),
            omittedBytes: 0,
          },
        },
      ],
    });
  });
});
