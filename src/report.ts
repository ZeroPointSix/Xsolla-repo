import type { ChangedFile, ReviewResult, ValidationResult } from "./types.js";

function quoted(value: string): string {
  return JSON.stringify(value);
}

function changedFileLine(file: ChangedFile): string {
  if (file.previousPath) {
    return `- ${file.status}: ${quoted(file.previousPath)} -> ${quoted(file.path)}`;
  }
  return `- ${file.status}: ${quoted(file.path)}`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
}

function codeBlock(value: string): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return [fence, value, fence];
}

function validationLines(result: ValidationResult, index: number): string[] {
  const lines = [
    `### Validation ${index + 1}`,
    "",
    `- Command: ${quoted(result.command)}`,
    `- Status: ${result.status}`,
    `- Exit code: ${result.exitCode ?? "none"}`,
    `- Signal: ${result.signal ?? "none"}`,
    `- Duration: ${result.durationMs} ms`,
    `- Output truncated: ${result.truncated ? "yes" : "no"}`,
  ];

  if (result.stdout) {
    lines.push("", "Standard output:", "", ...codeBlock(result.stdout));
  }
  if (result.stderr) {
    lines.push("", "Standard error:", "", ...codeBlock(result.stderr));
  }
  if (!result.stdout && !result.stderr) {
    lines.push("", "No command output.");
  }
  return lines;
}

export function markdownReport(result: ReviewResult): string {
  const lines = [
    `# Review Report: ${result.repository.name}`,
    "",
    `Base ref: ${quoted(result.repository.baseRef)}`,
    "",
    "## Summary",
    "",
    `- Changed files: ${result.summary.changedFiles}`,
    `- Validations: ${result.summary.validations}`,
    `- Passed: ${result.summary.passed}`,
    `- Failed: ${result.summary.failed}`,
    `- Timed out: ${result.summary.timedOut}`,
    `- Execution errors: ${result.summary.errors}`,
    "",
    "## Changed files",
    "",
  ];

  if (result.changedFiles.length === 0) {
    lines.push("No changes found.");
  } else {
    lines.push(...result.changedFiles.map(changedFileLine));
  }

  lines.push("", "## Validation output", "");
  if (result.validationResults.length === 0) {
    lines.push("No validation commands were run.");
  } else {
    result.validationResults.forEach((validation, index) => {
      if (index > 0) lines.push("");
      lines.push(...validationLines(validation, index));
    });
  }

  return `${lines.join("\n")}\n`;
}

export function jsonReport(result: ReviewResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
