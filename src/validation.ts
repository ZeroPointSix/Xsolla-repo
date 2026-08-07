import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ValidationOutputTruncation, ValidationResult } from "./types.js";

export const VALIDATION_KILL_GRACE_MS = 1_000;
export const CLI_VALIDATION_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  terminationGraceMs: VALIDATION_KILL_GRACE_MS,
});
export const MCP_VALIDATION_DEFAULTS = Object.freeze({
  timeoutMs: 15_000,
  maxOutputBytes: 32 * 1024,
  terminationGraceMs: VALIDATION_KILL_GRACE_MS,
});

export type ValidationLimits = {
  timeoutMs: number;
  maxOutputBytes: number;
  terminationGraceMs: number;
};

export type ValidationOptions = Partial<ValidationLimits>;

type CapturedOutput = {
  output: string;
  truncation: ValidationOutputTruncation;
};

type ProcessTreeTarget = Pick<ChildProcess, "pid" | "kill">;

type ProcessTreeTerminationDependencies = {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
};

export class ValidationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCommandError";
  }
}

const unsupportedShellSyntax: Record<string, string> = {
  ";": "command separators",
  "|": "pipelines",
  "&": "shell operators",
  "<": "redirections",
  ">": "redirections",
  "(": "shell grouping",
  ")": "shell grouping",
  "{": "shell expansion",
  "}": "shell expansion",
  "*": "globbing",
  "?": "globbing",
  "[": "globbing",
  "]": "globbing",
  "#": "comments",
  "~": "home-directory expansion",
};

const MINIMUM_OUTPUT_BYTES = 128;

function rejectUnsupportedSyntax(character: string): never {
  throw new ValidationCommandError(
    `Validation commands do not support ${unsupportedShellSyntax[character]} (${character}).`,
  );
}

function requirePositiveFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationCommandError(`${name} must be a positive finite number.`);
  }
}

function resolveValidationLimits(options: ValidationOptions): ValidationLimits {
  const limits = { ...CLI_VALIDATION_DEFAULTS, ...options };
  requirePositiveFiniteNumber("timeoutMs", limits.timeoutMs);
  requirePositiveFiniteNumber("terminationGraceMs", limits.terminationGraceMs);
  if (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) {
    throw new ValidationCommandError("maxOutputBytes must be a positive safe integer.");
  }
  if (limits.maxOutputBytes < MINIMUM_OUTPUT_BYTES) {
    throw new ValidationCommandError(
      `maxOutputBytes must be at least ${MINIMUM_OUTPUT_BYTES} bytes to retain output diagnostics.`,
    );
  }
  return limits;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(firstByte: number): number {
  if ((firstByte & 0b1000_0000) === 0) {
    return 1;
  }
  if ((firstByte & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((firstByte & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((firstByte & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}

function trimIncompleteUtf8Suffix(bytes: Buffer): Buffer {
  if (bytes.length === 0) {
    return bytes;
  }

  let sequenceStart = bytes.length - 1;
  while (sequenceStart > 0 && isUtf8ContinuationByte(bytes[sequenceStart])) {
    sequenceStart -= 1;
  }

  const availableBytes = bytes.length - sequenceStart;
  if (utf8SequenceLength(bytes[sequenceStart]) > availableBytes) {
    return bytes.subarray(0, sequenceStart);
  }
  return bytes;
}

function trimIncompleteUtf8Prefix(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && isUtf8ContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start);
}

/**
 * Keeps no more than the configured source-output budget while retaining the
 * first quarter and last three quarters of a stream. The tail-heavy split makes
 * failures' final diagnostics more likely to survive truncation.
 */
class BoundedOutputCapture {
  private readonly head: Buffer;
  private readonly tail: Buffer;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private headLength = 0;
  private tailLength = 0;
  private tailStart = 0;
  private totalBytes = 0;

  constructor(private readonly maxOutputBytes: number) {
    this.headLimit = Math.floor(maxOutputBytes / 4);
    this.tailLimit = maxOutputBytes - this.headLimit;
    this.head = Buffer.alloc(this.headLimit);
    this.tail = Buffer.alloc(this.tailLimit);
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    let offset = 0;

    const headAvailable = this.headLimit - this.headLength;
    if (headAvailable > 0) {
      const headBytes = Math.min(headAvailable, chunk.length);
      chunk.copy(this.head, this.headLength, 0, headBytes);
      this.headLength += headBytes;
      offset += headBytes;
    }

    if (offset < chunk.length) {
      this.appendToTail(chunk.subarray(offset));
    }
  }

  capture(): CapturedOutput {
    if (this.totalBytes <= this.maxOutputBytes) {
      return {
        output: Buffer.concat([
          this.head.subarray(0, this.headLength),
          this.tailContents(),
        ]).toString("utf8"),
        truncation: {
          truncated: false,
          capturedBytes: this.totalBytes,
          omittedBytes: 0,
        },
      };
    }

    let marker = this.omissionMarker(this.totalBytes);
    while (true) {
      const { head, tail } = this.retainedUtf8Buffers(this.maxOutputBytes - marker.length);
      const capturedBytes = head.length + tail.length;
      const omittedBytes = this.totalBytes - capturedBytes;
      const nextMarker = this.omissionMarker(omittedBytes);

      if (nextMarker.length === marker.length) {
        return {
          output: Buffer.concat([head, nextMarker, tail]).toString("utf8"),
          truncation: {
            truncated: true,
            capturedBytes,
            omittedBytes,
          },
        };
      }
      marker = nextMarker;
    }
  }

  private retainedUtf8Buffers(sourceBudget: number): { head: Buffer; tail: Buffer } {
    const headBudget = Math.floor(sourceBudget / 4);
    const tailBudget = sourceBudget - headBudget;
    const head = trimIncompleteUtf8Suffix(
      this.head.subarray(0, Math.min(this.headLength, headBudget)),
    );
    const allTail = this.tailContents();
    const tail = trimIncompleteUtf8Prefix(
      allTail.subarray(Math.max(0, allTail.length - tailBudget)),
    );
    return { head, tail };
  }

  private appendToTail(chunk: Buffer): void {
    if (chunk.length >= this.tailLimit) {
      chunk.copy(this.tail, 0, chunk.length - this.tailLimit);
      this.tailStart = 0;
      this.tailLength = this.tailLimit;
      return;
    }

    const tailEnd = (this.tailStart + this.tailLength) % this.tailLimit;
    const firstLength = Math.min(chunk.length, this.tailLimit - tailEnd);
    chunk.copy(this.tail, tailEnd, 0, firstLength);
    if (firstLength < chunk.length) {
      chunk.copy(this.tail, 0, firstLength);
    }

    const overflow = Math.max(0, this.tailLength + chunk.length - this.tailLimit);
    this.tailStart = (this.tailStart + overflow) % this.tailLimit;
    this.tailLength = Math.min(this.tailLimit, this.tailLength + chunk.length);
  }

  private omissionMarker(omittedBytes: number): Buffer {
    return Buffer.from(`\n[... ${omittedBytes} bytes omitted ...]\n`);
  }

  private tailContents(): Buffer {
    if (this.tailLength === 0) {
      return Buffer.alloc(0);
    }

    const tailEnd = this.tailStart + this.tailLength;
    if (tailEnd <= this.tailLimit) {
      return this.tail.subarray(this.tailStart, tailEnd);
    }

    return Buffer.concat([
      this.tail.subarray(this.tailStart),
      this.tail.subarray(0, tailEnd - this.tailLimit),
    ]);
  }
}

export function terminateProcessTree(
  child: ProcessTreeTarget,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeTerminationDependencies = {},
): void {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }

  const terminateChild = () => {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited between the timeout and this signal.
    }
  };

  if ((dependencies.platform ?? process.platform) === "win32") {
    const taskkillArgs = [
      "/PID",
      String(pid),
      "/T",
      ...(signal === "SIGKILL" ? ["/F"] : []),
    ];
    try {
      const taskkill = (dependencies.spawn ?? spawn)("taskkill", taskkillArgs, {
        shell: false,
        windowsHide: true,
      });
      taskkill.once("error", terminateChild);
    } catch {
      terminateChild();
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // The process may already have exited, or groups may be unavailable.
    terminateChild();
  }
}

/**
 * Splits a deliberately small command-string grammar into an executable and
 * arguments. Quoted arguments may contain spaces and literal shell characters;
 * shell grammar itself is rejected because validation commands never use a shell.
 */
export function tokenizeValidationCommand(command: string): string[] {
  const args: string[] = [];
  let argument = "";
  let argumentStarted = false;
  let quote: "'" | '"' | undefined;

  for (const character of command) {
    if (character === "\n" || character === "\r") {
      throw new ValidationCommandError("Validation commands must not contain newlines.");
    }

    if (character === "$" || character === "`") {
      throw new ValidationCommandError(
        "Validation commands do not support shell substitutions or expansions.",
      );
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        argument += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      argumentStarted = true;
      continue;
    }

    if (character === " " || character === "\t") {
      if (argumentStarted) {
        args.push(argument);
        argument = "";
        argumentStarted = false;
      }
      continue;
    }

    if (character in unsupportedShellSyntax) {
      rejectUnsupportedSyntax(character);
    }

    argument += character;
    argumentStarted = true;
  }

  if (quote === "'") {
    throw new ValidationCommandError("Validation command has an unterminated single-quoted argument.");
  }
  if (quote === '"') {
    throw new ValidationCommandError("Validation command has an unterminated double-quoted argument.");
  }
  if (argumentStarted) {
    args.push(argument);
  }
  if (args.length === 0) {
    throw new ValidationCommandError("Validation command must not be empty.");
  }

  return args;
}

export async function runValidation(
  command: string,
  cwd: string,
  options: ValidationOptions = CLI_VALIDATION_DEFAULTS,
): Promise<ValidationResult> {
  const [file, ...args] = tokenizeValidationCommand(command);
  const limits = resolveValidationLimits(options);

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
    });
    const stdout = new BoundedOutputCapture(limits.maxOutputBytes);
    const stderr = new BoundedOutputCapture(limits.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let closedAfterTimeout = false;
    let killSent = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const outputResult = () => {
      const capturedStdout = stdout.capture();
      const capturedStderr = stderr.capture();
      return {
        stdout: capturedStdout.output,
        stderr: capturedStderr.output,
        stdoutTruncation: capturedStdout.truncation,
        stderrTruncation: capturedStderr.truncation,
      };
    };

    const settle = (result: ValidationResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(forceKillTimer);
        resolve(result);
      }
    };

    const settleTimedOut = () => {
      if (closedAfterTimeout && killSent) {
        settle({
          command,
          status: "timed_out",
          exitCode: null,
          ...outputResult(),
          timeoutMs: limits.timeoutMs,
        });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.once("error", (error: Error) => {
      settle({
        command,
        status: "error",
        exitCode: null,
        ...outputResult(),
        error: error.message,
      });
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        closedAfterTimeout = true;
        settleTimedOut();
        return;
      }

      settle({
        command,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        ...outputResult(),
        ...(signal ? { signal } : {}),
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
        killSent = true;
        settleTimedOut();
      }, limits.terminationGraceMs);
    }, limits.timeoutMs);
  });
}

export async function runValidations(
  commands: string[],
  cwd: string,
  options: ValidationOptions = CLI_VALIDATION_DEFAULTS,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}
