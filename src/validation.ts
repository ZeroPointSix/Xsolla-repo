import { spawn } from "node:child_process";
import { parseCommand, type ParsedCommand } from "./command.js";
import type { ValidationResult } from "./types.js";

export type ValidationOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

class BoundedText {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    this.headLimit = Math.floor(maxBytes / 2);
    this.tailLimit = maxBytes - this.headLimit;
  }

  append(chunk: Buffer | string): void {
    let value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += value.length;

    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      const headPart = value.subarray(0, needed);
      this.head = Buffer.concat([this.head, headPart]);
      value = value.subarray(headPart.length);
    }

    if (value.length > 0) {
      this.tail = Buffer.concat([this.tail, value]);
      if (this.tail.length > this.tailLimit) {
        this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
      }
    }
  }

  get truncated(): boolean {
    return this.totalBytes > this.maxBytes;
  }

  value(): string {
    if (!this.truncated) {
      return Buffer.concat([this.head, this.tail]).toString("utf8");
    }

    const omitted = this.totalBytes - this.head.length - this.tail.length;
    const marker = `\n... output truncated (${omitted} bytes omitted) ...\n`;
    return `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`;
  }
}

function durationMs(startedAt: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
}

function errorResult(command: string, error: unknown, startedAt: bigint): ValidationResult {
  return {
    command,
    status: "error",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    durationMs: durationMs(startedAt),
    truncated: false,
  };
}

export function runValidation(
  command: string,
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const startedAt = process.hrtime.bigint();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Math.max(128, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(command);
  } catch (error) {
    return Promise.resolve(errorResult(command, error, startedAt));
  }

  return new Promise((resolve) => {
    const stdout = new BoundedText(maxOutputBytes);
    const stderr = new BoundedText(maxOutputBytes);
    let settled = false;
    let timedOut = false;

    const child = spawn(parsed.file, parsed.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    const finish = (result: ValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    child.once("error", (error) => {
      finish({
        ...errorResult(command, error, startedAt),
        stdout: stdout.value(),
        stderr: [stderr.value(), error.message].filter(Boolean).join("\n"),
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    child.once("close", (exitCode, signal) => {
      finish({
        command,
        status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: durationMs(startedAt),
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

export async function runValidations(
  commands: string[],
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}
