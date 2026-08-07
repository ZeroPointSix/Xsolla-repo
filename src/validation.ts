import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ValidationOutputTruncation, ValidationResult } from "./types.js";

export const VALIDATION_KILL_GRACE_MS = 1_000;
/** Node clamps larger setTimeout delays to one millisecond. */
export const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
/** A practical per-stream allocation cap (both stdout and stderr are captured). */
export const MAXIMUM_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MINIMUM_OUTPUT_BYTES = 128;
export const VALIDATION_TASKKILL_OBSERVATION_MS = 250;
export const VALIDATION_POST_KILL_SETTLE_MS = 250;

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

export type ValidationDependencies = {
  /** Test seam; production uses the host platform. */
  platform?: NodeJS.Platform;
  /** Test seam for the validation executable. */
  spawn?: typeof spawn;
  /** Test seam for Windows taskkill. */
  taskkillSpawn?: typeof spawn;
  /** Test seam for POSIX process-group signals. */
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Bounds how long taskkill may remain unobservable before direct-child fallback. */
  taskkillObservationMs?: number;
  /** Bounds how long to await a child close after forced cleanup. */
  postKillSettleMs?: number;
};

type CapturedOutput = {
  output: string;
  truncation: ValidationOutputTruncation;
};

type ProcessTreeTarget = Pick<ChildProcess, "pid" | "kill"> &
  Partial<Pick<ChildProcess, "unref" | "stdout" | "stderr">>;

export type ProcessTreeTerminationDependencies = Pick<
  ValidationDependencies,
  "platform" | "taskkillSpawn" | "killProcessGroup" | "taskkillObservationMs"
>;

export type ProcessTreeTermination = {
  succeeded: boolean;
  error?: string;
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

function rejectUnsupportedSyntax(character: string): never {
  throw new ValidationCommandError(
    `Validation commands do not support ${unsupportedShellSyntax[character]} (${character}).`,
  );
}

function requireTimerDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_TIMER_DELAY_MS) {
    throw new ValidationCommandError(
      `${name} must be a positive safe integer no greater than ${MAXIMUM_TIMER_DELAY_MS} ms.`,
    );
  }
}

function resolveValidationLimits(options: ValidationOptions): ValidationLimits {
  const limits = { ...CLI_VALIDATION_DEFAULTS, ...options };
  requireTimerDelay("timeoutMs", limits.timeoutMs);
  requireTimerDelay("terminationGraceMs", limits.terminationGraceMs);
  if (
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes < MINIMUM_OUTPUT_BYTES ||
    limits.maxOutputBytes > MAXIMUM_OUTPUT_BYTES
  ) {
    throw new ValidationCommandError(
      `maxOutputBytes must be a safe integer between ${MINIMUM_OUTPUT_BYTES} and ${MAXIMUM_OUTPUT_BYTES} bytes.`,
    );
  }
  return limits;
}

function boundedInternalDelay(value: number | undefined, fallback: number): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAXIMUM_TIMER_DELAY_MS
  ) {
    return value;
  }
  return fallback;
}

function unrefTimer(callback: () => void, delay: number): NodeJS.Timeout {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return timer;
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) {
    return 2;
  }
  if (firstByte >= 0xe0 && firstByte <= 0xef) {
    return 3;
  }
  if (firstByte >= 0xf0 && firstByte <= 0xf4) {
    return 4;
  }
  return 1;
}

/** Removes a possibly valid UTF-8 sequence split by a raw capture boundary. */
function trimIncompleteUtf8Suffix(bytes: Buffer): Buffer {
  if (bytes.length === 0) {
    return bytes;
  }
  let sequenceStart = bytes.length - 1;
  while (sequenceStart > 0 && isContinuationByte(bytes[sequenceStart])) {
    sequenceStart -= 1;
  }
  return utf8SequenceLength(bytes[sequenceStart]) > bytes.length - sequenceStart
    ? bytes.subarray(0, sequenceStart)
    : bytes;
}

/** Removes continuation bytes whose leading byte fell outside a raw tail capture. */
function trimIncompleteUtf8Prefix(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && isContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start);
}

/**
 * Replaces every malformed UTF-8 source byte with one ASCII question mark while
 * copying valid sequences byte-for-byte. Therefore sanitising never expands the
 * output, and output byte counts remain identical to retained source byte counts.
 */
function sanitizeUtf8(bytes: Buffer): string {
  const sanitized = Buffer.from(bytes);
  for (let index = 0; index < sanitized.length; ) {
    const first = sanitized[index];
    let sequenceLength = 0;

    if (first <= 0x7f) {
      sequenceLength = 1;
    } else if (
      first >= 0xc2 &&
      first <= 0xdf &&
      index + 1 < sanitized.length &&
      isContinuationByte(sanitized[index + 1])
    ) {
      sequenceLength = 2;
    } else if (
      first === 0xe0 &&
      index + 2 < sanitized.length &&
      sanitized[index + 1] >= 0xa0 &&
      sanitized[index + 1] <= 0xbf &&
      isContinuationByte(sanitized[index + 2])
    ) {
      sequenceLength = 3;
    } else if (
      ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) &&
      index + 2 < sanitized.length &&
      isContinuationByte(sanitized[index + 1]) &&
      isContinuationByte(sanitized[index + 2])
    ) {
      sequenceLength = 3;
    } else if (
      first === 0xed &&
      index + 2 < sanitized.length &&
      sanitized[index + 1] >= 0x80 &&
      sanitized[index + 1] <= 0x9f &&
      isContinuationByte(sanitized[index + 2])
    ) {
      sequenceLength = 3;
    } else if (
      first === 0xf0 &&
      index + 3 < sanitized.length &&
      sanitized[index + 1] >= 0x90 &&
      sanitized[index + 1] <= 0xbf &&
      isContinuationByte(sanitized[index + 2]) &&
      isContinuationByte(sanitized[index + 3])
    ) {
      sequenceLength = 4;
    } else if (
      first >= 0xf1 &&
      first <= 0xf3 &&
      index + 3 < sanitized.length &&
      isContinuationByte(sanitized[index + 1]) &&
      isContinuationByte(sanitized[index + 2]) &&
      isContinuationByte(sanitized[index + 3])
    ) {
      sequenceLength = 4;
    } else if (
      first === 0xf4 &&
      index + 3 < sanitized.length &&
      sanitized[index + 1] >= 0x80 &&
      sanitized[index + 1] <= 0x8f &&
      isContinuationByte(sanitized[index + 2]) &&
      isContinuationByte(sanitized[index + 3])
    ) {
      sequenceLength = 4;
    }

    if (sequenceLength === 0) {
      sanitized[index] = 0x3f;
      sequenceLength = 1;
    }
    index += sequenceLength;
  }
  return sanitized.toString("utf8");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type RetainedText = {
  text: string;
  sourceBytes: number;
};

function retainHeadGraphemes(text: string, byteBudget: number): RetainedText {
  let sourceBytes = 0;
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const segmentBytes = Buffer.byteLength(segment);
    if (sourceBytes + segmentBytes > byteBudget) {
      break;
    }
    sourceBytes += segmentBytes;
    end = index + segment.length;
  }
  return { text: text.slice(0, end), sourceBytes };
}

function retainTailGraphemes(text: string, byteBudget: number): RetainedText {
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= byteBudget) {
    return { text, sourceBytes: totalBytes };
  }

  let bytesBefore = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    if (totalBytes - bytesBefore <= byteBudget) {
      return { text: text.slice(index), sourceBytes: totalBytes - bytesBefore };
    }
    bytesBefore += Buffer.byteLength(segment);
  }
  return { text: "", sourceBytes: 0 };
}

/**
 * Retains a bounded raw source-byte head and tail. At serialisation time it
 * sanitises malformed UTF-8 and cuts only on grapheme boundaries, leaving room
 * for the omission marker within the same configured stream budget.
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
      const output = sanitizeUtf8(
        Buffer.concat([this.head.subarray(0, this.headLength), this.tailContents()]),
      );
      return {
        output,
        truncation: {
          truncated: false,
          capturedBytes: this.totalBytes,
          omittedBytes: 0,
        },
      };
    }

    let marker = this.omissionMarker(this.totalBytes);
    while (true) {
      const retained = this.retainedText(this.maxOutputBytes - Buffer.byteLength(marker));
      const omittedBytes = this.totalBytes - retained.sourceBytes;
      const nextMarker = this.omissionMarker(omittedBytes);
      if (Buffer.byteLength(nextMarker) === Buffer.byteLength(marker)) {
        const output = `${retained.head.text}${nextMarker}${retained.tail.text}`;
        return {
          output,
          truncation: {
            truncated: true,
            capturedBytes: retained.sourceBytes,
            omittedBytes,
          },
        };
      }
      marker = nextMarker;
    }
  }

  private retainedText(sourceBudget: number): { head: RetainedText; tail: RetainedText; sourceBytes: number } {
    const headBudget = Math.floor(sourceBudget / 4);
    const tailBudget = sourceBudget - headBudget;
    // Segment the full raw captures before applying the smaller serialisation
    // budgets so a boundary has look-ahead/look-behind for combining marks and
    // ZWJ sequences. Boundary-split UTF-8 source bytes are omitted, not decoded
    // as replacement characters.
    const head = retainHeadGraphemes(
      sanitizeUtf8(trimIncompleteUtf8Suffix(this.head.subarray(0, this.headLength))),
      headBudget,
    );
    const tail = retainTailGraphemes(
      sanitizeUtf8(trimIncompleteUtf8Prefix(this.tailContents())),
      tailBudget,
    );
    return { head, tail, sourceBytes: head.sourceBytes + tail.sourceBytes };
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

  private omissionMarker(omittedBytes: number): string {
    return `\n[... ${omittedBytes} bytes omitted ...]\n`;
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

function terminateDirectChild(child: ProcessTreeTarget, signal: NodeJS.Signals): string {
  try {
    return child.kill(signal)
      ? `sent ${signal} to the direct child`
      : `could not signal the direct child with ${signal}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not signal the direct child with ${signal}: ${message}`;
  }
}

/**
 * Requests termination of the validation process tree and observes the request
 * rather than treating taskkill spawn as success. A Windows failure falls back
 * to its direct child but records that descendant cleanup is unconfirmed.
 */
export function terminateProcessTree(
  child: ProcessTreeTarget,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeTerminationDependencies = {},
): Promise<ProcessTreeTermination> {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve({
      succeeded: false,
      error: "Validation process has no valid PID; process-tree cleanup cannot be confirmed.",
    });
  }

  const failWithDirectChildFallback = (reason: string): ProcessTreeTermination => ({
    succeeded: false,
    error: `${reason}; ${terminateDirectChild(child, signal)}. Descendant cleanup cannot be confirmed.`,
  });

  if ((dependencies.platform ?? process.platform) !== "win32") {
    try {
      (dependencies.killProcessGroup ?? process.kill)(-pid, signal);
      return Promise.resolve({ succeeded: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve(
        failWithDirectChildFallback(`Could not signal process group ${pid} with ${signal}: ${message}`),
      );
    }
  }

  const observationMs = boundedInternalDelay(
    dependencies.taskkillObservationMs,
    VALIDATION_TASKKILL_OBSERVATION_MS,
  );
  const taskkillArgs = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];

  return new Promise((resolve) => {
    let settled = false;
    let observationTimer: NodeJS.Timeout | undefined;
    const settle = (result: ProcessTreeTermination) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(observationTimer);
      resolve(result);
    };

    try {
      const taskkill = (dependencies.taskkillSpawn ?? spawn)("taskkill", taskkillArgs, {
        shell: false,
        windowsHide: true,
      });
      taskkill.unref();
      taskkill.once("error", (error: Error) => {
        settle(
          failWithDirectChildFallback(
            `taskkill failed to start or execute for PID ${pid}: ${error.message}`,
          ),
        );
      });
      taskkill.once("close", (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (code === 0) {
          settle({ succeeded: true });
          return;
        }
        const detail = closeSignal ? `signal ${closeSignal}` : `exit code ${code ?? "unavailable"}`;
        settle(failWithDirectChildFallback(`taskkill for PID ${pid} ended with ${detail}`));
      });
      observationTimer = unrefTimer(() => {
        settle(
          failWithDirectChildFallback(
            `taskkill for PID ${pid} did not report completion within ${observationMs} ms`,
          ),
        );
      }, observationMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(failWithDirectChildFallback(`taskkill could not be spawned for PID ${pid}: ${message}`));
    }
  });
}

function releaseUnconfirmedChild(child: ProcessTreeTarget): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
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
  dependencies: ValidationDependencies = {},
): Promise<ValidationResult> {
  const [file, ...args] = tokenizeValidationCommand(command);
  const limits = resolveValidationLimits(options);
  // Deliberately allocate both bounded captures before a validation can start.
  const stdout = new BoundedOutputCapture(limits.maxOutputBytes);
  const stderr = new BoundedOutputCapture(limits.maxOutputBytes);
  const platform = dependencies.platform ?? process.platform;

  return new Promise((resolve) => {
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

    let child: ChildProcess;
    try {
      child = (dependencies.spawn ?? spawn)(file, args, {
        cwd,
        detached: platform !== "win32",
        shell: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        command,
        status: "error",
        exitCode: null,
        ...outputResult(),
        error: message,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let initialTerminationCompleted = false;
    let forcedTerminationStarted = false;
    let forcedTerminationCompleted = false;
    const terminationErrors: string[] = [];
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let postKillTimer: NodeJS.Timeout | undefined;

    const settle = (result: ValidationResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(forceKillTimer);
        clearTimeout(postKillTimer);
        resolve(result);
      }
    };

    const recordTermination = (attempt: ProcessTreeTermination) => {
      if (!attempt.succeeded && attempt.error) {
        terminationErrors.push(attempt.error);
      }
    };

    const timeoutResult = (unconfirmedCleanup = false) => {
      if (unconfirmedCleanup) {
        terminationErrors.push(
          "Validation process did not close after forced cleanup; process-tree cleanup cannot be confirmed.",
        );
        releaseUnconfirmedChild(child);
      }
      settle({
        command,
        status: "timed_out",
        exitCode: null,
        ...outputResult(),
        timeoutMs: limits.timeoutMs,
        ...(terminationErrors.length > 0
          ? { terminationError: terminationErrors.join(" ") }
          : {}),
      });
    };

    const maybeSettleTimedOut = () => {
      if (!timedOut || !childClosed) {
        return;
      }
      if (!forcedTerminationStarted && initialTerminationCompleted) {
        timeoutResult();
      }
      if (forcedTerminationStarted && forcedTerminationCompleted) {
        timeoutResult();
      }
    };

    const requestTermination = (signal: NodeJS.Signals) =>
      terminateProcessTree(child, signal, {
        platform,
        taskkillSpawn: dependencies.taskkillSpawn,
        killProcessGroup: dependencies.killProcessGroup,
        taskkillObservationMs: dependencies.taskkillObservationMs,
      });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.once("error", (error: Error) => {
      if (timedOut) {
        terminationErrors.push(`Validation child emitted an error during cleanup: ${error.message}`);
        return;
      }
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
        childClosed = true;
        maybeSettleTimedOut();
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

    timeoutTimer = unrefTimer(() => {
      timedOut = true;
      void requestTermination("SIGTERM").then((attempt) => {
        initialTerminationCompleted = true;
        recordTermination(attempt);
        maybeSettleTimedOut();
      });

      forceKillTimer = unrefTimer(() => {
        if (settled || childClosed) {
          return;
        }
        forcedTerminationStarted = true;
        void requestTermination("SIGKILL").then((attempt) => {
          forcedTerminationCompleted = true;
          recordTermination(attempt);
          maybeSettleTimedOut();
          if (!childClosed && !settled) {
            postKillTimer = unrefTimer(
              () => timeoutResult(true),
              boundedInternalDelay(
                dependencies.postKillSettleMs,
                VALIDATION_POST_KILL_SETTLE_MS,
              ),
            );
          }
        });
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
