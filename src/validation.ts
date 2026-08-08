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
  /** Test seam for probing a negative POSIX process-group ID with signal zero. */
  probeProcessGroup?: (processGroupId: number) => void;
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

type ProcessGroupProbe = {
  absent: boolean;
  error?: string;
};

export type ProcessTreeTermination = {
  succeeded: boolean;
  error?: string;
};

type TerminationOperation = {
  /** The bounded request, retained so escalation can wait for both operations. */
  promise: Promise<ProcessTreeTermination>;
  outcome?: ProcessTreeTermination;
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

/**
 * An unref'd taskkill helper can still emit an error after bounded observation
 * ends. This handler deliberately captures no child or validation state.
 */
function ignoreUnobservableTaskkillError(): void {}

function releaseTaskkillHelper(helper: Pick<ChildProcess, "unref">): string {
  try {
    helper.unref();
    return "was unref'd";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not be unref'd: ${message}`;
  }
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

function errnoIs(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Probes the negative PGID: ESRCH is the only positive confirmation of absence. */
function probePosixProcessGroup(
  pid: number,
  dependencies: Pick<ValidationDependencies, "probeProcessGroup">,
): ProcessGroupProbe {
  try {
    (dependencies.probeProcessGroup ?? ((processGroupId) => process.kill(processGroupId, 0)))(-pid);
    return { absent: false };
  } catch (error) {
    if (errnoIs(error, "ESRCH")) {
      return { absent: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { absent: false, error: message };
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
      if (errnoIs(error, "ESRCH")) {
        return Promise.resolve({ succeeded: true });
      }
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
    let reapingHelper = false;
    let observationTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    let fallback: ProcessTreeTermination | undefined;
    let taskkill: ChildProcess | undefined;

    function onTaskkillError(error: Error): void {
      if (settled) {
        return;
      }
      if (reapingHelper) {
        const helperReleaseDetail = taskkill
          ? releaseTaskkillHelper(taskkill)
          : "could not be unref'd: taskkill helper became unavailable";
        // An error after SIGKILL does not guarantee that no later error event
        // can arrive, so leave only the non-capturing safety listener behind.
        settle(
          helperFailure(
            `taskkill helper emitted an error while being reaped: ${error.message}; ${helperReleaseDetail}.`,
          ),
          true,
        );
        return;
      }
      settle(
        failWithDirectChildFallback(
          `taskkill failed to start or execute for PID ${pid}: ${error.message}`,
        ),
      );
    }

    function onTaskkillClose(code: number | null, closeSignal: NodeJS.Signals | null): void {
      if (settled) {
        return;
      }
      const detail = closeSignal ? `signal ${closeSignal}` : `exit code ${code ?? "unavailable"}`;
      if (reapingHelper) {
        settle(helperFailure(`taskkill helper closed with ${detail} after forced helper cleanup.`));
        return;
      }
      if (code === 0) {
        settle({ succeeded: true });
        return;
      }
      settle(failWithDirectChildFallback(`taskkill for PID ${pid} ended with ${detail}`));
    }

    const cleanupTaskkillObservation = (guardUnobservableHelper = false) => {
      clearTimeout(observationTimer);
      clearTimeout(reapTimer);
      if (!taskkill) {
        return;
      }
      taskkill.removeListener("error", onTaskkillError);
      taskkill.removeListener("close", onTaskkillClose);
      if (guardUnobservableHelper) {
        taskkill.on("error", ignoreUnobservableTaskkillError);
      }
    };
    const settle = (result: ProcessTreeTermination, guardUnobservableHelper = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTaskkillObservation(guardUnobservableHelper);
      resolve(result);
    };
    const helperFailure = (detail: string): ProcessTreeTermination => ({
      succeeded: false,
      error: `${fallback?.error ?? "taskkill helper became unobservable."} ${detail}`,
    });

    try {
      taskkill = (dependencies.taskkillSpawn ?? spawn)("taskkill", taskkillArgs, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", onTaskkillError);
      taskkill.once("close", onTaskkillClose);
      // This timer deliberately remains referenced so the helper outcome is
      // observed before validation cleanup is allowed to continue.
      observationTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        const helper = taskkill;
        if (!helper) {
          settle(failWithDirectChildFallback("taskkill helper became unavailable during observation"));
          return;
        }
        reapingHelper = true;
        fallback = failWithDirectChildFallback(
          `taskkill for PID ${pid} did not report completion within ${observationMs} ms`,
        );
        let helperKillDetail: string;
        try {
          helperKillDetail = helper.kill("SIGKILL")
            ? "sent SIGKILL to the taskkill helper"
            : "could not signal the taskkill helper with SIGKILL";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          helperKillDetail = `could not signal the taskkill helper with SIGKILL: ${message}`;
        }
        // kill() can synchronously emit the listeners registered above. In that
        // terminal path, onTaskkillError has already released the helper and
        // installed its non-capturing late-error guard; do not create a timer
        // after its cleanup has run.
        if (settled) {
          return;
        }
        // Give the killed helper one more bounded, referenced interval to close
        // or error so it is reaped whenever that can be observed.
        reapTimer = setTimeout(() => {
          const helperReleaseDetail = releaseTaskkillHelper(helper);
          settle(
            helperFailure(
              `${helperKillDetail}; taskkill helper remained unobservable for a further ${observationMs} ms and ${helperReleaseDetail} without confirmation.`,
            ),
            true,
          );
        }, observationMs);
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
      const capturedOutput = outputResult();
      resolve({
        command,
        status: "error",
        exitCode: null,
        ...capturedOutput,
        error: message,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let initialTermination: TerminationOperation | undefined;
    let forcedTermination: TerminationOperation | undefined;
    let posixProcessGroupAbsent = false;
    let lastPosixProbeError: string | undefined;
    // Failed termination attempts are diagnostic context, not proof that final
    // cleanup failed. Attach them only if the final cleanup state is unconfirmed.
    const terminationAttemptDiagnostics: string[] = [];
    const isPosix = platform !== "win32";
    const processGroupPid =
      typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0
        ? child.pid
        : undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let postKillTimer: NodeJS.Timeout | undefined;

    const detachChildListeners = () => {
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
    };

    const settle = (
      result: Omit<
        ValidationResult,
        "stdout" | "stderr" | "stdoutTruncation" | "stderrTruncation"
      >,
      releaseChild = false,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(postKillTimer);
      // Final output must be captured while the data listeners are still live.
      const capturedOutput = outputResult();
      detachChildListeners();
      if (releaseChild) {
        // Destruction can synchronously emit stream events, so detach first.
        releaseUnconfirmedChild(child);
      }
      resolve({ ...result, ...capturedOutput });
    };

    const recordTermination = (operation: TerminationOperation) => {
      if (!operation.outcome?.succeeded && operation.outcome?.error) {
        terminationAttemptDiagnostics.push(operation.outcome.error);
      }
    };

    const timeoutResult = (unconfirmedCleanupReason?: string) => {
      if (settled) {
        return;
      }
      const terminationError = unconfirmedCleanupReason
        ? [unconfirmedCleanupReason, ...terminationAttemptDiagnostics].join(" ")
        : undefined;
      settle(
        {
          command,
          status: "timed_out",
          exitCode: null,
          timeoutMs: limits.timeoutMs,
          ...(terminationError ? { terminationError } : {}),
        },
        unconfirmedCleanupReason !== undefined,
      );
    };

    const confirmPosixProcessGroupAbsent = (): boolean => {
      if (!isPosix || posixProcessGroupAbsent) {
        return posixProcessGroupAbsent;
      }
      if (processGroupPid === undefined) {
        lastPosixProbeError = "Validation process has no valid PID for process-group cleanup.";
        return false;
      }
      const probe = probePosixProcessGroup(processGroupPid, dependencies);
      if (probe.absent) {
        posixProcessGroupAbsent = true;
        lastPosixProbeError = undefined;
        return true;
      }
      lastPosixProbeError = probe.error;
      return false;
    };

    const startWindowsPostKillFallback = () => {
      if (settled || childClosed || postKillTimer) {
        return;
      }
      postKillTimer = setTimeout(
        () =>
          timeoutResult(
            "Validation process did not close after forced cleanup; process-tree cleanup cannot be confirmed.",
          ),
        boundedInternalDelay(dependencies.postKillSettleMs, VALIDATION_POST_KILL_SETTLE_MS),
      );
    };

    const maybeSettleTimedOut = () => {
      if (!timedOut) {
        return;
      }
      if (isPosix) {
        if (!childClosed) {
          return;
        }
        // A direct-child close says nothing about detached descendants. Only an
        // ESRCH probe of the negative PGID permits an early timeout result.
        if (!confirmPosixProcessGroupAbsent()) {
          return;
        }
        if (!forcedTermination && initialTermination?.outcome) {
          timeoutResult();
        }
        if (forcedTermination?.outcome) {
          timeoutResult();
        }
        return;
      }

      // Before grace expires, only a confirmed successful /T plus a child close
      // proves cleanup. A direct-child fallback after failed /T must leave the
      // referenced grace timer intact so /F still runs.
      if (!forcedTermination) {
        if (childClosed && initialTermination?.outcome?.succeeded) {
          timeoutResult();
        }
        return;
      }

      // Once escalation starts, a Windows timeout cannot settle until both
      // bounded taskkill helpers report a terminal outcome, in either order.
      if (!initialTermination?.outcome || !forcedTermination.outcome) {
        return;
      }
      if (childClosed && forcedTermination.outcome.succeeded) {
        timeoutResult();
      } else if (childClosed) {
        timeoutResult(
          "Forced taskkill did not confirm process-tree cleanup; process-tree cleanup cannot be confirmed.",
        );
      } else {
        startWindowsPostKillFallback();
      }
    };

    const requestTermination = (signal: NodeJS.Signals) =>
      terminateProcessTree(child, signal, {
        platform,
        taskkillSpawn: dependencies.taskkillSpawn,
        killProcessGroup: dependencies.killProcessGroup,
        taskkillObservationMs: dependencies.taskkillObservationMs,
      });

    const finishTermination = (
      operation: TerminationOperation,
      outcome: ProcessTreeTermination,
    ) => {
      if (operation.outcome) {
        return;
      }
      operation.outcome = outcome;
      recordTermination(operation);
      maybeSettleTimedOut();
    };

    const startTermination = (signal: NodeJS.Signals): TerminationOperation => {
      let promise: Promise<ProcessTreeTermination>;
      try {
        promise = requestTermination(signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        promise = Promise.resolve({
          succeeded: false,
          error: `Termination request ${signal} could not be started: ${message}`,
        });
      }
      const operation: TerminationOperation = { promise };
      void operation.promise.then(
        (outcome) => finishTermination(operation, outcome),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          finishTermination(operation, {
            succeeded: false,
            error: `Termination request ${signal} failed unexpectedly: ${message}`,
          });
        },
      );
      return operation;
    };

    const startPosixPostKillConfirmation = () => {
      const followUpMs = boundedInternalDelay(
        dependencies.postKillSettleMs,
        VALIDATION_POST_KILL_SETTLE_MS,
      );
      const deadline = Date.now() + followUpMs;
      const confirmUntilDeadline = () => {
        if (settled) {
          return;
        }
        if (confirmPosixProcessGroupAbsent()) {
          maybeSettleTimedOut();
          if (!childClosed && !settled) {
            postKillTimer = setTimeout(
              () =>
                timeoutResult(
                  "Validation direct child did not close after its process group was killed; process-tree cleanup cannot be confirmed.",
                ),
              Math.max(1, deadline - Date.now()),
            );
          }
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const reason = lastPosixProbeError
            ? `Could not confirm process group ${processGroupPid ?? "unavailable"} is absent after SIGKILL: ${lastPosixProbeError}.`
            : `Process group ${processGroupPid ?? "unavailable"} remained after SIGKILL for ${followUpMs} ms.`;
          timeoutResult(`${reason} Process-tree cleanup cannot be confirmed.`);
          return;
        }
        postKillTimer = setTimeout(confirmUntilDeadline, Math.min(10, remaining));
      };
      confirmUntilDeadline();
    };

    function onStdoutData(chunk: Buffer): void {
      stdout.append(chunk);
    }

    function onStderrData(chunk: Buffer): void {
      stderr.append(chunk);
    }

    function onChildError(error: Error): void {
      if (timedOut) {
        if (!settled) {
          terminationAttemptDiagnostics.push(
            `Validation child emitted an error during cleanup: ${error.message}`,
          );
        }
        return;
      }
      settle({
        command,
        status: "error",
        exitCode: null,
        error: error.message,
      });
    }

    function onChildClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (timedOut) {
        childClosed = true;
        maybeSettleTimedOut();
        return;
      }

      settle({
        command,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        ...(signal ? { signal } : {}),
      });
    }

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.once("error", onChildError);
    child.once("close", onChildClose);

    timeoutTimer = unrefTimer(() => {
      timedOut = true;
      initialTermination = startTermination("SIGTERM");

      // Keep this timer referenced: after SIGTERM the direct child can close
      // while descendants still occupy its detached POSIX process group.
      forceKillTimer = setTimeout(() => {
        if (settled || (isPosix && posixProcessGroupAbsent)) {
          return;
        }
        forcedTermination = startTermination("SIGKILL");
        if (isPosix) {
          void forcedTermination.promise.then(
            () => startPosixPostKillConfirmation(),
            () => startPosixPostKillConfirmation(),
          );
        }
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
