import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runValidation,
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
      output: "validation ran",
    });
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
