import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownReport } from "../src/report.js";
import {
  CLI_VALIDATION_DEFAULTS,
  MAXIMUM_OUTPUT_BYTES,
  MAXIMUM_TIMER_DELAY_MS,
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
const FIXTURE_WAIT_TIMEOUT_MS = 10_000;
const FIXTURE_POLL_INTERVAL_MS = 10;
const childFixturePath = fileURLToPath(
  new URL("./fixtures/validation-child.cjs", import.meta.url),
);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  timeoutMs = FIXTURE_WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value !== undefined) {
      return value as T;
    }
    await new Promise((resolve) => setTimeout(resolve, FIXTURE_POLL_INTERVAL_MS));
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

async function waitForFixtureMarker(marker: string, expected: string): Promise<void> {
  await waitFor(async () => {
    if (!existsSync(marker)) {
      return undefined;
    }
    const content = await readFile(marker, "utf8");
    return content.includes(expected) ? true : undefined;
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
    // Timeout cleanup normally already ended the fixture.
  }
}

function fakeChild(pid = 4_321): ChildProcess {
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
    stdout,
    stderr,
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

function fakeTaskkill(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

function graphemePrefix(value: string, source: string): boolean {
  if (value === "") {
    return true;
  }
  for (const { segment, index } of graphemeSegmenter.segment(source)) {
    if (source.slice(0, index + segment.length) === value) {
      return true;
    }
  }
  return false;
}

function graphemeSuffix(value: string, source: string): boolean {
  if (value === "") {
    return true;
  }
  for (const { index } of graphemeSegmenter.segment(source)) {
    if (source.slice(index) === value) {
      return true;
    }
  }
  return false;
}

function omissionMarker(output: string): RegExpMatchArray {
  const marker = output.match(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
  expect(marker).not.toBeNull();
  return marker as RegExpMatchArray;
}

function expectBoundedSerializedOutput(
  output: string,
  truncation: { capturedBytes: number; omittedBytes: number },
  budget: number,
): void {
  const marker = omissionMarker(output)[0];
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(budget);
  expect(Buffer.byteLength(output)).toBe(
    truncation.capturedBytes + Buffer.byteLength(marker),
  );
  expect(truncation.capturedBytes).toBeGreaterThan(0);
  expect(truncation.omittedBytes).toBeGreaterThan(0);
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
  it("uses shellless numeric taskkill arguments and observes a successful close", async () => {
    const child = fakeChild();
    const termTaskkill = fakeTaskkill();
    const forceTaskkill = fakeTaskkill();
    const spawnTaskkill = vi
      .fn()
      .mockReturnValueOnce(termTaskkill)
      .mockReturnValueOnce(forceTaskkill);

    const term = terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      taskkillSpawn: spawnTaskkill as never,
      taskkillObservationMs: 25,
    });
    const termErrorListener = termTaskkill.listeners("error")[0];
    const termCloseListener = termTaskkill.listeners("close")[0];
    expect(termErrorListener).toBeTypeOf("function");
    expect(termCloseListener).toBeTypeOf("function");
    termTaskkill.emit("close", 0, null);
    const force = terminateProcessTree(child, "SIGKILL", {
      platform: "win32",
      taskkillSpawn: spawnTaskkill as never,
      taskkillObservationMs: 25,
    });
    const forceErrorListener = forceTaskkill.listeners("error")[0];
    const forceCloseListener = forceTaskkill.listeners("close")[0];
    expect(forceErrorListener).toBeTypeOf("function");
    expect(forceCloseListener).toBeTypeOf("function");
    forceTaskkill.emit("close", 0, null);

    await expect(term).resolves.toEqual({ succeeded: true });
    await expect(force).resolves.toEqual({ succeeded: true });
    for (const [taskkill, errorListener, closeListener] of [
      [termTaskkill, termErrorListener, termCloseListener],
      [forceTaskkill, forceErrorListener, forceCloseListener],
    ] as const) {
      expect(taskkill.listenerCount("error")).toBe(0);
      expect(taskkill.listenerCount("close")).toBe(0);
      expect(taskkill.listeners("error")).not.toContain(errorListener);
      expect(taskkill.listeners("close")).not.toContain(closeListener);
    }
    expect(spawnTaskkill).toHaveBeenNthCalledWith(
      1,
      "taskkill",
      ["/PID", "4321", "/T"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(spawnTaskkill).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(termTaskkill.unref).not.toHaveBeenCalled();
    expect(forceTaskkill.unref).not.toHaveBeenCalled();
  });

  it("observes nonzero taskkill close codes and falls back to the direct child", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const termination = terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      taskkillSpawn: vi.fn(() => taskkill) as never,
      taskkillObservationMs: 25,
    });
    const errorListener = taskkill.listeners("error")[0];
    const closeListener = taskkill.listeners("close")[0];
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listenerCount("close")).toBe(1);
    expect(errorListener).toBeTypeOf("function");
    expect(closeListener).toBeTypeOf("function");
    taskkill.emit("close", 5, null);

    await expect(termination).resolves.toMatchObject({
      succeeded: false,
      error: expect.stringContaining("exit code 5"),
    });
    expect(taskkill.listenerCount("error")).toBe(0);
    expect(taskkill.listenerCount("close")).toBe(0);
    expect(taskkill.listeners("error")).not.toContain(errorListener);
    expect(taskkill.listeners("close")).not.toContain(closeListener);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("observes taskkill spawn errors and records direct-child fallback", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const termination = terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      taskkillSpawn: vi.fn(() => taskkill) as never,
      taskkillObservationMs: 25,
    });
    const errorListener = taskkill.listeners("error")[0];
    const closeListener = taskkill.listeners("close")[0];
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listenerCount("close")).toBe(1);
    expect(errorListener).toBeTypeOf("function");
    expect(closeListener).toBeTypeOf("function");
    taskkill.emit("error", new Error("ENOENT"));

    await expect(termination).resolves.toMatchObject({
      succeeded: false,
      error: expect.stringContaining("ENOENT"),
    });
    expect(taskkill.listenerCount("error")).toBe(0);
    expect(taskkill.listenerCount("close")).toBe(0);
    expect(taskkill.listeners("error")).not.toContain(errorListener);
    expect(taskkill.listeners("close")).not.toContain(closeListener);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("releases a helper whose SIGKILL synchronously emits an error without scheduling a reap timer", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const helperKill = vi.fn(() => {
      taskkill.emit("error", new Error("synchronous helper failure"));
      return true;
    });
    Object.assign(taskkill, { kill: helperKill });
    const observationMs = 20;
    const started = Date.now();

    const terminationPromise = terminateProcessTree(child, "SIGKILL", {
      platform: "win32",
      taskkillSpawn: vi.fn(() => taskkill) as never,
      taskkillObservationMs: observationMs,
    });
    const errorListener = taskkill.listeners("error")[0];
    const closeListener = taskkill.listeners("close")[0];
    expect(errorListener).toBeTypeOf("function");
    expect(closeListener).toBeTypeOf("function");

    await expect(terminationPromise).resolves.toMatchObject({
      succeeded: false,
      error: expect.stringContaining("synchronous helper failure"),
    });

    // The terminal error happens inside kill(), so cleanup must already have
    // released the helper before the termination promise resolves.
    expect(Date.now() - started).toBeLessThan(150);
    expect(helperKill).toHaveBeenCalledWith("SIGKILL");
    expect(taskkill.unref).toHaveBeenCalledOnce();
    expect(taskkill.listenerCount("close")).toBe(0);
    expect(taskkill.listeners("close")).not.toContain(closeListener);
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listeners("error")).not.toContain(errorListener);
    expect(taskkill.listeners("error")[0]?.name).toBe("ignoreUnobservableTaskkillError");
    expect(() => taskkill.emit("error", new Error("late helper failure"))).not.toThrow();

    // If a reap timer were installed after synchronous settlement, it would
    // invoke unref a second time and extend the host's referenced lifetime.
    await new Promise((resolve) => setTimeout(resolve, observationMs + 20));
    expect(taskkill.unref).toHaveBeenCalledOnce();
  });

  it("kills and reaps a hanging taskkill helper after its observation window", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const helperKill = vi.fn(() => {
      queueMicrotask(() => taskkill.emit("close", null, "SIGKILL"));
      return true;
    });
    Object.assign(taskkill, { kill: helperKill });
    const started = Date.now();

    const terminationPromise = terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      taskkillSpawn: vi.fn(() => taskkill) as never,
      taskkillObservationMs: 20,
    });
    const errorListener = taskkill.listeners("error")[0];
    const closeListener = taskkill.listeners("close")[0];
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listenerCount("close")).toBe(1);
    expect(errorListener).toBeTypeOf("function");
    expect(closeListener).toBeTypeOf("function");
    const termination = await terminationPromise;

    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(250);
    expect(termination).toMatchObject({
      succeeded: false,
      error: expect.stringContaining("did not report completion within 20 ms"),
    });
    expect(termination.error).toContain("closed with signal SIGKILL after forced helper cleanup");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(helperKill).toHaveBeenCalledWith("SIGKILL");
    expect(taskkill.unref).not.toHaveBeenCalled();
    expect(taskkill.listenerCount("error")).toBe(0);
    expect(taskkill.listenerCount("close")).toBe(0);
    expect(taskkill.listeners("error")).not.toContain(errorListener);
    expect(taskkill.listeners("close")).not.toContain(closeListener);
  });

  it("bounds an unobservable taskkill helper across both observation windows", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const taskkillSpawn = vi.fn(() => taskkill);
    const started = Date.now();

    const terminationPromise = terminateProcessTree(child, "SIGKILL", {
      platform: "win32",
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 20,
    });
    const errorListener = taskkill.listeners("error")[0];
    const closeListener = taskkill.listeners("close")[0];
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listenerCount("close")).toBe(1);
    expect(errorListener).toBeTypeOf("function");
    expect(closeListener).toBeTypeOf("function");
    const termination = await terminationPromise;

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(300);
    expect(termination).toMatchObject({
      succeeded: false,
      error: expect.stringContaining("remained unobservable for a further 20 ms and was unref'd"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(taskkillSpawn).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(taskkill.kill).toHaveBeenCalledWith("SIGKILL");
    expect(taskkill.unref).toHaveBeenCalledOnce();
    expect(taskkill.listenerCount("error")).toBe(1);
    expect(taskkill.listenerCount("close")).toBe(0);
    expect(taskkill.listeners("error")).not.toContain(errorListener);
    expect(taskkill.listeners("close")).not.toContain(closeListener);
    expect(taskkill.listeners("error")[0]?.name).toBe("ignoreUnobservableTaskkillError");
    expect(() => taskkill.emit("error", new Error("late ENOENT"))).not.toThrow();
  });

  it("does not interpolate invalid process identifiers into taskkill arguments", async () => {
    const spawnTaskkill = vi.fn();
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        terminateProcessTree(fakeChild(pid), "SIGTERM", {
          platform: "win32",
          taskkillSpawn: spawnTaskkill as never,
        }),
      ).resolves.toMatchObject({ succeeded: false });
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

    expect(result).toMatchObject({ status: "failed", exitCode: null, signal: "SIGTERM" });
    expect(
      markdownReport({
        repositoryPath: directory,
        changedFiles: [],
        validationResults: [result],
      }),
    ).toContain("- Signal: SIGTERM");
  });

  it.skipIf(process.platform === "win32")(
    "terminates a timed-out POSIX process group and its descendants",
    async () => {
      const directory = await createTemporaryDirectory();
      const parentMarker = join(directory, "parent-marker");
      const descendantMarker = join(directory, "descendant-marker");
      const validation = runValidation(
        childFixtureCommand("hang-with-descendant", parentMarker, descendantMarker),
        directory,
        { timeoutMs: 3_000, terminationGraceMs: 500 },
      );
      const parentPid = await readFixturePid(parentMarker);
      const descendantPid = await readFixturePid(descendantMarker);
      fixturePids.add(parentPid);
      fixturePids.add(descendantPid);

      const result = await validation;
      expect(result).toMatchObject({ status: "timed_out", exitCode: null, timeoutMs: 3_000 });
      expect(result.terminationError).toBeUndefined();
      await waitForFixtureMarker(parentMarker, "TERM");
      await waitForFixtureMarker(descendantMarker, "TERM");
      await waitForProcessExit(parentPid);
      await waitForProcessExit(descendantPid);
    },
    15_000,
  );

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    it.skipIf(process.platform === "win32")(
      `keeps escalation active when a SIGTERM parent exit leaves a descendant (attempt ${attempt}/10)`,
      async () => {
        const directory = await createTemporaryDirectory();
        const parentMarker = join(directory, `exiting-parent-${attempt}`);
        const descendantMarker = join(directory, `term-ignoring-descendant-${attempt}`);
        const validation = runValidation(
          childFixtureCommand(
            "parent-exits-on-term-with-descendant",
            parentMarker,
            descendantMarker,
          ),
          directory,
          { timeoutMs: 3_000, terminationGraceMs: 500 },
        );
        const parentPid = await readFixturePid(parentMarker);
        const descendantPid = await readFixturePid(descendantMarker);
        fixturePids.add(parentPid);
        fixturePids.add(descendantPid);

        const result = await validation;
        expect(result).toMatchObject({ status: "timed_out", exitCode: null, timeoutMs: 3_000 });
        expect(result.terminationError).toBeUndefined();
        await waitForFixtureMarker(parentMarker, "TERM");
        await waitForFixtureMarker(descendantMarker, "TERM-IGNORED");
        // This is deliberately immediate: resolution itself is the cleanup
        // boundary, rather than a later best-effort background operation.
        expect(isProcessRunning(descendantPid)).toBe(false);
      },
      15_000,
    );
  }

  it.skipIf(process.platform !== "win32")(
    "cleans up Windows timed-out descendants with taskkill",
    async () => {
      const directory = await createTemporaryDirectory();
      const parentMarker = join(directory, "parent-marker");
      const descendantMarker = join(directory, "descendant-marker");
      const validation = runValidation(
        childFixtureCommand("hang-with-descendant", parentMarker, descendantMarker),
        directory,
        { timeoutMs: 3_000, terminationGraceMs: 500 },
      );
      const parentPid = await readFixturePid(parentMarker);
      const descendantPid = await readFixturePid(descendantMarker);
      fixturePids.add(parentPid);
      fixturePids.add(descendantPid);

      const result = await validation;
      expect(result).toMatchObject({ status: "timed_out", exitCode: null, timeoutMs: 3_000 });
      await waitForProcessExit(parentPid);
      await waitForProcessExit(descendantPid);
    },
  );

  it("makes a forced Windows taskkill attempt after the grace period", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const spawnedTaskkill: ChildProcess[] = [];
    const taskkillSpawn = vi.fn(() => {
      const taskkill = fakeTaskkill();
      spawnedTaskkill.push(taskkill);
      queueMicrotask(() => taskkill.emit("close", 0, null));
      return taskkill;
    });
    const started = Date.now();

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 10,
      postKillSettleMs: 10,
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({
      status: "timed_out",
      terminationError: expect.stringContaining("did not close after forced cleanup"),
    });
    expect(taskkillSpawn).toHaveBeenCalledTimes(2);
    expect(taskkillSpawn).toHaveBeenLastCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(spawnedTaskkill.every((taskkill) => (taskkill.unref as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
  });

  it("settles within a bounded post-kill period when Windows taskkill is unobservable", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const taskkillSpawn = vi.fn(() => fakeTaskkill());
    const started = Date.now();

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 10,
      postKillSettleMs: 10,
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({
      status: "timed_out",
      terminationError: expect.stringContaining("taskkill for PID 4321 did not report completion"),
    });
    expect(result.terminationError).toContain("process-tree cleanup cannot be confirmed");
    expect(taskkillSpawn).toHaveBeenLastCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("waits for the bounded initial Windows helper cleanup after forced taskkill succeeds", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const initialTaskkill = fakeTaskkill();
    const forcedTaskkill = fakeTaskkill();
    const taskkillSpawn = vi
      .fn()
      .mockReturnValueOnce(initialTaskkill)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          forcedTaskkill.emit("close", 0, null);
          child.emit("close", null, "SIGKILL");
        });
        return forcedTaskkill;
      });
    const started = Date.now();

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 20,
      postKillSettleMs: 10,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(taskkillSpawn).toHaveBeenCalledTimes(2);
    expect(taskkillSpawn).toHaveBeenLastCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(initialTaskkill.kill).toHaveBeenCalledWith("SIGKILL");
    expect(initialTaskkill.unref).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "timed_out" });
    expect(result.terminationError).toBeUndefined();
  });

  it("confirms Windows cleanup after initial /T exits 5, the child closes, and /F succeeds", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const initialTaskkill = fakeTaskkill();
    const forcedTaskkill = fakeTaskkill();
    Object.assign(child, {
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        }
        return true;
      }),
    });
    const taskkillSpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => initialTaskkill.emit("close", 5, null));
        return initialTaskkill;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => forcedTaskkill.emit("close", 0, null));
        return forcedTaskkill;
      });

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 20,
      postKillSettleMs: 10,
    });

    expect(result).toMatchObject({ status: "timed_out" });
    expect(result.terminationError).toBeUndefined();
    expect(taskkillSpawn).toHaveBeenCalledTimes(2);
    expect(taskkillSpawn).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
  });

  it("keeps failed Windows attempt diagnostics when forced cleanup remains unconfirmed", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const initialTaskkill = fakeTaskkill();
    const forcedTaskkill = fakeTaskkill();
    const taskkillSpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => initialTaskkill.emit("close", 5, null));
        return initialTaskkill;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => forcedTaskkill.emit("close", 0, null));
        return forcedTaskkill;
      });

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 20,
      postKillSettleMs: 10,
    });

    expect(result).toMatchObject({
      status: "timed_out",
      terminationError: expect.stringContaining("did not close after forced cleanup"),
    });
    expect(result.terminationError).toContain("exit code 5");
    expect(result.terminationError?.indexOf("did not close after forced cleanup")).toBeLessThan(
      result.terminationError?.indexOf("exit code 5") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("confirms POSIX cleanup when a failed TERM attempt is followed by an ESRCH probe", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    Object.assign(child, {
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        }
        return true;
      }),
    });
    const killProcessGroup = vi.fn(() => {
      throw new Error("EPERM");
    });
    const probeProcessGroup = vi.fn(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    const result = await runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 20,
    }, {
      platform: "linux",
      spawn: vi.fn(() => child) as never,
      killProcessGroup,
      probeProcessGroup,
    });

    expect(result).toMatchObject({ status: "timed_out" });
    expect(result.terminationError).toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(probeProcessGroup).toHaveBeenCalledWith(-4321);
  });

  it("waits when forced Windows taskkill completes before the initial helper", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const initialTaskkill = fakeTaskkill();
    const forcedTaskkill = fakeTaskkill();
    const taskkillSpawn = vi
      .fn()
      .mockReturnValueOnce(initialTaskkill)
      .mockReturnValueOnce(forcedTaskkill);
    let validationSettled = false;
    const validation = runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 250,
      postKillSettleMs: 10,
    });
    void validation.then(() => {
      validationSettled = true;
    });

    await waitFor(() => (taskkillSpawn.mock.calls.length === 2 ? true : undefined));
    forcedTaskkill.emit("close", 0, null);
    child.emit("close", null, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(validationSettled).toBe(false);

    initialTaskkill.emit("close", 0, null);
    const result = await validation;
    expect(result.status).toBe("timed_out");
    expect(result.terminationError).toBeUndefined();
  });

  it("detaches fake unclosable-child listeners before releasing bounded captures", async () => {
    const directory = await createTemporaryDirectory();
    const child = fakeChild();
    const taskkillSpawn = vi.fn(() => fakeTaskkill());
    const validation = runValidation(`node -e "process.stdout.write('unused')"`, directory, {
      timeoutMs: 5,
      terminationGraceMs: 5,
    }, {
      platform: "win32",
      spawn: vi.fn(() => child) as never,
      taskkillSpawn: taskkillSpawn as never,
      taskkillObservationMs: 10,
      postKillSettleMs: 10,
    });
    child.stdout?.emit("data", Buffer.from("captured before cleanup"));

    const result = await validation;

    expect(result).toMatchObject({
      status: "timed_out",
      stdout: "captured before cleanup",
    });
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout?.listenerCount("data")).toBe(0);
    expect(child.stderr?.listenerCount("data")).toBe(0);
    expect(child.stdout?.listeners("data")).toEqual([]);
    expect(child.stderr?.listeners("data")).toEqual([]);
    expect(child.stdout?.destroy).toHaveBeenCalledOnce();
    expect(child.stderr?.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();

    child.stdout?.emit("data", Buffer.from(" late output"));
    expect(result.stdout).toBe("captured before cleanup");
  });

  it("continues serial validation after a timeout", async () => {
    const directory = await createTemporaryDirectory();
    const marker = join(directory, "timeout-marker");
    const results = await runValidations(
      [
        childFixtureCommand("stay-alive", marker),
        `node -e "process.stdout.write('second ran')"`,
      ],
      directory,
      { timeoutMs: 1_000, terminationGraceMs: 250 },
    );

    expect(results).toMatchObject([
      { status: "timed_out", exitCode: null, timeoutMs: 1_000 },
      { status: "passed", exitCode: 0, stdout: "second ran" },
    ]);
  });

  it.each(["stdout", "stderr"] as const)(
    "keeps malformed 0xFF %s valid UTF-8 without expanding it",
    async (stream) => {
      const directory = await createTemporaryDirectory();
      const result = await runValidation(
        childFixtureCommand("malformed-output", stream),
        directory,
      );
      const output = stream === "stdout" ? result.stdout : result.stderr;
      const expected = `${stream}-head:?:${stream}-tail`;

      expect(result.status).toBe("passed");
      expect(output).toBe(expected);
      expect(output).not.toContain("�");
      expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(expected));
      expect(stream === "stdout" ? result.stdoutTruncation : result.stderrTruncation).toEqual(
        untruncated(Buffer.byteLength(expected)),
      );
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "bounds oversized %s including the omission marker and source metadata",
    async (stream) => {
      const directory = await createTemporaryDirectory();
      const budget = 128;
      const size = 1_024;
      const result = await runValidation(
        childFixtureCommand("large-output", stream, String(size)),
        directory,
        { maxOutputBytes: budget },
      );
      const output = stream === "stdout" ? result.stdout : result.stderr;
      const truncation = stream === "stdout" ? result.stdoutTruncation : result.stderrTruncation;
      const source = `${stream}-head\n${"x".repeat(size)}\n${stream}-tail\n`;

      expect(result.status).toBe("passed");
      expect(truncation.truncated).toBe(true);
      expect(truncation.capturedBytes + truncation.omittedBytes).toBe(Buffer.byteLength(source));
      expectBoundedSerializedOutput(output, truncation, budget);
      expect(output).toContain(`${stream}-head`);
      expect(output).toContain(`${stream}-tail`);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "keeps truncated malformed %s within its byte budget",
    async (stream) => {
      const directory = await createTemporaryDirectory();
      const budget = 128;
      const malformedBytes = 1_024;
      const result = await runValidation(
        childFixtureCommand("malformed-output", stream, String(malformedBytes)),
        directory,
        { maxOutputBytes: budget },
      );
      const output = stream === "stdout" ? result.stdout : result.stderr;
      const truncation = stream === "stdout" ? result.stdoutTruncation : result.stderrTruncation;

      expect(output).not.toContain("�");
      expect(output).toContain(`${stream}-head:`);
      expect(output).toContain(`:${stream}-tail`);
      expectBoundedSerializedOutput(output, truncation, budget);
      expect(truncation.capturedBytes + truncation.omittedBytes).toBe(
        Buffer.byteLength(`${stream}-head:`) + malformedBytes + Buffer.byteLength(`:${stream}-tail`),
      );
    },
  );

  it("preserves valid head and tail text at Unicode grapheme boundaries", async () => {
    const directory = await createTemporaryDirectory();
    const stream = "stdout";
    const repetitions = 64;
    const budget = 256;
    const decomposed = "é";
    const zwjEmoji = "👩‍💻";
    const cjk = "漢字";
    const source =
      `${stream}-head:${decomposed}:${zwjEmoji}:${cjk}\n` +
      `${decomposed}${zwjEmoji}${cjk}`.repeat(repetitions) +
      `\n${stream}-tail:${decomposed}:${zwjEmoji}:${cjk}\n`;
    const result = await runValidation(
      childFixtureCommand("grapheme-output", stream, String(repetitions)),
      directory,
      { maxOutputBytes: budget },
    );
    const marker = omissionMarker(result.stdout)[0];
    const markerIndex = result.stdout.indexOf(marker);
    const retainedHead = result.stdout.slice(0, markerIndex);
    const retainedTail = result.stdout.slice(markerIndex + marker.length);

    expect(result.status).toBe("passed");
    expect(result.stdout).not.toContain("�");
    expect(graphemePrefix(retainedHead, source)).toBe(true);
    expect(graphemeSuffix(retainedTail, source)).toBe(true);
    expect(retainedHead).toContain(`${stream}-head:${decomposed}`);
    expect(retainedTail).toContain(`${stream}-tail:${decomposed}:${zwjEmoji}:${cjk}`);
    expectBoundedSerializedOutput(result.stdout, result.stdoutTruncation, budget);
    expect(
      result.stdoutTruncation.capturedBytes + result.stdoutTruncation.omittedBytes,
    ).toBe(Buffer.byteLength(source));
  });

  it.each([
    0,
    -1,
    127,
    128.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAXIMUM_OUTPUT_BYTES + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxOutputBytes value %p before spawning", async (maxOutputBytes) => {
    const directory = await createTemporaryDirectory();
    const spawnValidation = vi.fn();
    await expect(
      runValidation(`node -e "process.stdout.write('should not run')"`, directory, {
        maxOutputBytes,
      }, { spawn: spawnValidation as never }),
    ).rejects.toThrow("maxOutputBytes must be a safe integer between");
    expect(spawnValidation).not.toHaveBeenCalled();
  });

  it("does not launch a long-lived child when an oversized output budget is rejected", async () => {
    const directory = await createTemporaryDirectory();
    const marker = join(directory, "oversized-limit-child-marker");
    await expect(
      runValidation(childFixtureCommand("stay-alive", marker), directory, {
        maxOutputBytes: MAXIMUM_OUTPUT_BYTES + 1,
      }),
    ).rejects.toThrow("maxOutputBytes must be a safe integer between");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["timeoutMs", 0],
    ["timeoutMs", -1],
    ["timeoutMs", 1.5],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", Number.POSITIVE_INFINITY],
    ["timeoutMs", Number.MAX_SAFE_INTEGER + 1],
    ["timeoutMs", MAXIMUM_TIMER_DELAY_MS + 1],
    ["terminationGraceMs", 0],
    ["terminationGraceMs", -1],
    ["terminationGraceMs", 1.5],
    ["terminationGraceMs", Number.NaN],
    ["terminationGraceMs", Number.POSITIVE_INFINITY],
    ["terminationGraceMs", Number.MAX_SAFE_INTEGER + 1],
    ["terminationGraceMs", MAXIMUM_TIMER_DELAY_MS + 1],
  ] as const)("rejects invalid %s value %p before spawning", async (name, value) => {
    const directory = await createTemporaryDirectory();
    const spawnValidation = vi.fn();
    await expect(
      runValidation(
        `node -e "process.stdout.write('should not run')"`,
        directory,
        { [name]: value },
        { spawn: spawnValidation as never },
      ),
    ).rejects.toThrow(`${name} must be a positive safe integer no greater than`);
    expect(spawnValidation).not.toHaveBeenCalled();
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

  it.each([
    [
      "a command separator",
      (marker: string) =>
        `node -e "process.stdout.write('primary command')"; touch "${marker}"`,
      "command separators",
    ],
    [
      "a pipeline",
      (marker: string) => `node -e "process.stdout.write('primary command')" | touch "${marker}"`,
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
