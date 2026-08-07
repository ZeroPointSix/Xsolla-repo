export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
};

export type ValidationOutputTruncation = {
  truncated: boolean;
  capturedBytes: number;
  omittedBytes: number;
};

export type ValidationResult = {
  command: string;
  status: "passed" | "failed" | "error" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncation: ValidationOutputTruncation;
  stderrTruncation: ValidationOutputTruncation;
  signal?: NodeJS.Signals;
  error?: string;
  timeoutMs?: number;
  /** Present when timed-out process-tree cleanup could not be confirmed. */
  terminationError?: string;
};

export type ReviewRequest = {
  repositoryPath: string;
  baseRef?: string;
  validationCommands?: string[];
  format?: "markdown" | "json";
};