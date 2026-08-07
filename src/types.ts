export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "conflicted"
  | "untracked";

export type ChangedFile = {
  path: string;
  status: ChangedFileStatus;
  previousPath?: string;
};

export type ValidationStatus = "passed" | "failed" | "timeout" | "error";

export type ValidationResult = {
  command: string;
  status: ValidationStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
};

export type RepositoryInspection = {
  name: string;
  path: string;
  baseRef: string;
  changedFiles: ChangedFile[];
};

export type ReviewSummary = {
  changedFiles: number;
  validations: number;
  passed: number;
  failed: number;
  timedOut: number;
  errors: number;
};

export type ReviewResult = {
  repository: Omit<RepositoryInspection, "changedFiles">;
  changedFiles: ChangedFile[];
  validationResults: ValidationResult[];
  summary: ReviewSummary;
};

export type ReviewExecutionOptions = {
  validationTimeoutMs?: number;
  maxOutputBytes?: number;
};
