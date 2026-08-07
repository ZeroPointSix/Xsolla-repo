import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownReport } from "../src/report.js";
import {
  CLI_VALIDATION_DEFAULTS,
  MCP_VALIDATION_DEFAULTS,
  terminateProcessTree,
  VALIDATION_KILL_GRACE_MS,
  runValidation,
  runValidations,
  tokenizeValidationCommand,
  ValidationCommandError,
} from "../src/validation.js";

const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();
const childFixturePath = fileURLToPath(
  new URL("./fixtures/validation-child.cjs", import.meta.url),
);

function untruncated(capturedBytes: number) {
  return { truncated: false, capturedBytes, omittedBytes: 0 };
}

function childFixtureCommand(...args: string[]): string {
  return [process.execPath, childFixturePath, ...args]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-inspector-validation-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor<T>(
  callback: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value !== undefined) {
      return value as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for child fixture state.");
}

async function readFixturePid(marker: string): Promise<number> {
  return waitFor(async () => {
    if (!existsSync(marker)) {
      return undefined;
    }
    const content = await readFile(marker, "utf8");
    const pid = Number.parseInt(content, 10);
    return Number.isInteger(pid) ? pid : undefined;
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await waitFor(() => (isProcessRunning(pid) ? undefined : true));
}

function killFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The assertion normally confirms that timeout cleanup already ended it.
  }
}

afterEach(async () => {
  for (const pid of fixturePids) {
    killFixtureProcess(pid);
  }
  fixturePids.clear();
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

describe("terminateProcessTree", () => {
  it("uses exact shellless numeric taskkill arguments on every platform", () => {
    const child = { pid: 4_321, kill: vi.fn() };
    const taskkill = { once: vi.fn() };
    const spawnTaskkill = vi.fn(() => taskkill);
    const dependencies = { platform: "win32" as const, spawn: spawnTaskkill as never };

    terminateProcessTree(child as never, "SIGTERM", dependencies);
    terminateProcessTree(child as never, "SIGKILL", dependencies);

    expect(spawnTaskkill).toHaveBeenNthCalledWith(
      1,
      "taskkill",
      ["/PID", "4321", "/T"],
      { shell: false, windowsHide: true },
    );
    expect(spawnTaskkill).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, windowsHide: true },
    );
    expect(taskkill.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not interpolate invalid process identifiers into taskkill arguments", () => {
    const spawnTaskkill = vi.fn();
    const dependencies = { platform: "win32" as const, spawn: spawnTaskkill as never };

    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      terminateProcessTree({ pid, kill: vi.fn() } as never, "SIGTERM", dependencies);
    }

    expect(spawnTaskkill).not.toHaveBeenCalled();
  });
});

describe("runValidation", () => {
  it("exports distinct CLI and MCP resource defaults", () => {
    expect(CLI_VALIDATION_DEFAULTS).toEqual({
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
      terminationGraceMs: VALIDATION_KILL_GRACE_MS,
    });
    expect(MCP_VALIDATION_DEFAULTS).toEqual({
      timeoutMs: 15_000,
      maxOutputBytes: 32 * 1024,
      terminationGraceMs: VALIDATION_KILL_GRACE_MS,
    });
  });

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
      stdoutTruncation: untruncated(14),
      stderrTruncation: untruncated(0),
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
      stdoutTruncation: untruncated(15),
      stderrTruncation: untruncated(14),
    });
  });

  it("preserves SIGTERM diagnostics in the result and Markdown report", async () => {
    const directory = await createTemporaryDirectory();
    const command = `node -e "process.kill(process.pid, 'SIGTERM')"`;

    const result = await runValidation(command, directory);

    expect(result).toEqual({
      command,
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutTruncation: untruncated(0),
      stderrTruncation: untruncated(0),
      signal: "SIGTERM",
    });
    expect(
      markdownReport({
        repositoryPath: directory,
        changedFiles: [],
        validationResults: [result],
      }),
    ).toContain("- Signal: SIGTERM");
  });

  it.skipIf(process.platform === "win32")(
    "terminates a timed-out process group and its descendants with TERM then KILL",
    async () => {
      const directory = await createTemporaryDirectory();
      const parentMarker = join(directory, "parent-marker");
      const descendantMarker = join(directory, "descendant-marker");
      const validation = runValidation(
        childFixtureCommand("hang-with-descendant", parentMarker, descendantMarker),
        directory,
        { timeoutMs: 1_000, terminationGraceMs: 75 },
      );
      const parentPid = await readFixturePid(parentMarker);
      const descendantPid = await readFixturePid(descendantMarker);
      fixturePids.add(parentPid);
      fixturePids.add(descendantPid);

      const result = await validation;

      expect(result).toMatchObject({
        status: "timed_out",
        exitCode: null,
        timeoutMs: 1_000,
      });
      expect(result.stdoutTruncation).toEqual(untruncated(0));
      expect(result.stderrTruncation).toEqual(untruncated(0));
      await expect(readFile(parentMarker, "utf8")).resolves.toContain("TERM");
      await expect(readFile(descendantMarker, "utf8")).resolves.toContain("TERM");
      await waitForProcessExit(parentPid);
      await waitForProcessExit(descendantPid);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "cleans up Windows timed-out descendants with taskkill",
    async () => {
      const directory = await createTemporaryDirectory();
      const parentMarker = join(directory, "parent-marker");
      const descendantMarker = join(directory, "descendant-marker");
      const validation = runValidation(
        childFixtureCommand("hang-with-descendant", parentMarker, descendantMarker),
        directory,
        { timeoutMs: 1_000, terminationGraceMs: 75 },
      );
      const parentPid = await readFixturePid(parentMarker);
      const descendantPid = await readFixturePid(descendantMarker);
      fixturePids.add(parentPid);
      fixturePids.add(descendantPid);

      const result = await validation;

      expect(result).toMatchObject({
        status: "timed_out",
        exitCode: null,
        timeoutMs: 1_000,
      });
      await waitForProcessExit(parentPid);
      await waitForProcessExit(descendantPid);
    },
  );

  it("continues serial validation after a timeout", async () => {
    const directory = await createTemporaryDirectory();
    const marker = join(directory, "timeout-marker");

    const results = await runValidations(
      [
        childFixtureCommand("stay-alive", marker),
        `node -e "process.stdout.write('second ran')"`,
      ],
      directory,
      { timeoutMs: 1_000, terminationGraceMs: 25 },
    );

    expect(results).toMatchObject([
      { status: "timed_out", exitCode: null, timeoutMs: 1_000 },
      { status: "passed", exitCode: 0, stdout: "second ran" },
    ]);
  });

  it.each(["stdout", "stderr"] as const)(
    "bounds oversized %s while retaining head, omission marker, and tail",
    async (stream) => {
      const directory = await createTemporaryDirectory();
      const result = await runValidation(
        childFixtureCommand("large-output", stream, "1024"),
        directory,
        { maxOutputBytes: 128 },
      );
      const output = stream === "stdout" ? result.stdout : result.stderr;
      const truncation =
        stream === "stdout" ? result.stdoutTruncation : result.stderrTruncation;
      const otherOutput = stream === "stdout" ? result.stderr : result.stdout;
      const otherTruncation =
        stream === "stdout" ? result.stderrTruncation : result.stdoutTruncation;

      expect(result.status).toBe("passed");
      expect(truncation).toMatchObject({
        truncated: true,
        capturedBytes: expect.any(Number),
        omittedBytes: expect.any(Number),
      });
      expect(truncation.capturedBytes).toBeLessThanOrEqual(128);
      expect(truncation.omittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(128);
      expect(output).toContain(`${stream}-head`);
      expect(output).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/);
      expect(output).toContain(`${stream}-tail`);
      expect(otherOutput).toBe("");
      expect(otherTruncation).toEqual(untruncated(0));
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "keeps truncated %s UTF-8 safe while preserving its head and tail",
    async (stream) => {
      const directory = await createTemporaryDirectory();
      const repetitions = 96;
      const result = await runValidation(
        childFixtureCommand("unicode-large-output", stream, String(repetitions)),
        directory,
        { maxOutputBytes: 128 },
      );
      const output = stream === "stdout" ? result.stdout : result.stderr;
      const truncation =
        stream === "stdout" ? result.stdoutTruncation : result.stderrTruncation;
      const marker = output.match(/\n\[\.\.\. (\d+) bytes omitted \.\.\.\]\n/);
      const source =
        `${stream}-head-😀-漢\n` +
        "😀é漢".repeat(repetitions) +
        `\n${stream}-tail-😀-漢\n`;

      expect(result.status).toBe("passed");
      expect(output).not.toContain("�");
      expect(output).toMatch(new RegExp(`^${stream}-head-😀-漢\\n`));
      expect(output).toMatch(new RegExp(`${stream}-tail-😀-漢\\n$`));
      expect(marker).not.toBeNull();
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(128);
      expect(truncation).toEqual({
        truncated: true,
        capturedBytes: Buffer.byteLength(output) - Buffer.byteLength(marker?.[0] ?? ""),
        omittedBytes: Buffer.byteLength(source) - truncation.capturedBytes,
      });
    },
  );

  it.each([0, -1, 128.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxOutputBytes value %p",
    async (maxOutputBytes) => {
      const directory = await createTemporaryDirectory();

      await expect(
        runValidation(`node -e "process.stdout.write('should not run')"`, directory, {
          maxOutputBytes,
        }),
      ).rejects.toThrow("maxOutputBytes must be a positive safe integer.");
    },
  );

  it("retains the minimum output limit needed for omission diagnostics", async () => {
    const directory = await createTemporaryDirectory();

    await expect(
      runValidation(`node -e "process.stdout.write('should not run')"`, directory, {
        maxOutputBytes: 127,
      }),
    ).rejects.toThrow("maxOutputBytes must be at least 128 bytes");
  });

  it.each([
    ["timeoutMs", { timeoutMs: 0 }],
    ["timeoutMs", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["terminationGraceMs", { terminationGraceMs: -1 }],
    ["terminationGraceMs", { terminationGraceMs: Number.NaN }],
  ] as const)("rejects non-positive or non-finite %s", async (_name, options) => {
    const directory = await createTemporaryDirectory();

    await expect(
      runValidation(`node -e "process.stdout.write('should not run')"`, directory, options),
    ).rejects.toThrow("must be a positive finite number.");
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
      stdoutTruncation: untruncated(0),
      stderrTruncation: untruncated(0),
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
      stdoutTruncation: untruncated(0),
      stderrTruncation: untruncated(0),
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
