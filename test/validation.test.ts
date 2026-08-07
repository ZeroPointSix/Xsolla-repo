import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runValidation,
  runValidations,
  tokenizeValidationCommand,
  ValidationCommandError,
} from "../src/validation.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-inspector-validation-"));
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

describe("tokenizeValidationCommand", () => {
  it("splits ordinary quoted arguments without a shell", () => {
    expect(
      tokenizeValidationCommand(`node -e "process.stdout.write('quoted argument')"`),
    ).toEqual(["node", "-e", "process.stdout.write('quoted argument')"]);
  });

  it.each([
    ["newlines", "node -e \"process.stdout.write('ok')\"\ntouch marker"],
    ["unterminated single quotes", "node -e 'process.stdout.write(1)"],
    ["unterminated double quotes", 'node -e "process.stdout.write(1)'],
  ])("rejects %s with a clear error", (_description, command) => {
    expect(() => tokenizeValidationCommand(command)).toThrow(ValidationCommandError);
  });
});

describe("runValidation", () => {
  it("runs a valid command with separated executable and arguments", async () => {
    const directory = await createTemporaryDirectory();

    await expect(
      runValidation(`node -e "process.stdout.write('validation ran')"`, directory),
    ).resolves.toEqual({
      command: `node -e "process.stdout.write('validation ran')"`,
      status: "passed",
      exitCode: 0,
      stdout: "validation ran",
      stderr: "",
    });
  });

  it("returns failed with both streams and a nonzero exit code", async () => {
    const directory = await createTemporaryDirectory();

    await expect(
      runValidation(
        `node -e "process.stdout.write('standard output'); process.stderr.write('standard error'); process.exit(3)"`,
        directory,
      ),
    ).resolves.toEqual({
      command:
        `node -e "process.stdout.write('standard output'); process.stderr.write('standard error'); process.exit(3)"`,
      status: "failed",
      exitCode: 3,
      stdout: "standard output",
      stderr: "standard error",
    });
  });

  it("continues serially after a failed validation", async () => {
    const directory = await createTemporaryDirectory();

    const results = await runValidations(
      [
        `node -e "require('node:fs').writeFileSync('first-ran', 'yes'); process.exit(3)"`,
        `node -e "if (!require('node:fs').existsSync('first-ran')) process.exit(2); process.stdout.write('second ran')"`,
      ],
      directory,
    );

    expect(results).toMatchObject([
      { status: "failed", exitCode: 3 },
      { status: "passed", exitCode: 0, stdout: "second ran" },
    ]);
  });

  it("returns launch errors without rejecting", async () => {
    const directory = await createTemporaryDirectory();

    const result = await runValidation("definitely-not-an-executable", directory);

    expect(result).toMatchObject({
      command: "definitely-not-an-executable",
      status: "error",
      exitCode: null,
      stdout: "",
      stderr: "",
    });
    expect(result.error).toContain("ENOENT");
  });

  it("returns setup errors without rejecting", async () => {
    const directory = await createTemporaryDirectory();
    const missingDirectory = join(directory, "missing");

    const result = await runValidation(
      `node -e "process.stdout.write('should not run')"`,
      missingDirectory,
    );

    expect(result).toMatchObject({
      status: "error",
      exitCode: null,
      stdout: "",
      stderr: "",
    });
    expect(result.error).toContain("ENOENT");
  });

  it.each([
    [
      "a command separator",
      (marker: string) =>
        `node -e "process.stdout.write('primary command')"; touch "${marker}"`,
      "command separators",
    ],
    [
      "a pipeline",
      (marker: string) =>
        `node -e "process.stdout.write('primary command')" | touch "${marker}"`,
      "pipelines",
    ],
    [
      "a redirection",
      (marker: string) => `node -e "process.stdout.write('primary command')" > "${marker}"`,
      "redirections",
    ],
    [
      "a substitution",
      (marker: string) =>
        `node -e "process.stdout.write('$(touch ${marker})')"`,
      "shell substitutions or expansions",
    ],
  ])("rejects %s without creating the marker", async (_description, commandFor, error) => {
    const directory = await createTemporaryDirectory();
    const marker = join(directory, "marker");

    await expect(runValidation(commandFor(marker), directory)).rejects.toThrow(error);
    expect(existsSync(marker)).toBe(false);
  });
});
