import type { ChangedFile, ValidationResult } from "./types.js";

type ReportInput = {
  repositoryPath: string;
  changedFiles: ChangedFile[];
  validationResults: ValidationResult[];
};

export function markdownReport(input: ReportInput): string {
  const lines = [`# Review Report: ${input.repositoryPath}`, "", "## Changed files"];
  for (const file of input.changedFiles) {
    lines.push(`- ${file.path} (${file.status})`);
  }
  lines.push("", "## Validation output");
  for (const result of input.validationResults) {
    lines.push(
      `### ${result.command}`,
      `- Status: ${result.status}`,
      `- Exit code: ${result.exitCode ?? "unavailable"}`,
    );
    if (result.signal) {
      lines.push(`- Signal: ${result.signal}`);
    }
    lines.push(
      "#### stdout",
      "```",
      result.stdout,
      "```",
      "#### stderr",
      "```",
      result.stderr,
      "```",
    );
    if (result.error) {
      lines.push("- Execution error:", "```", result.error, "```");
    }
  }
  return lines.join("\n");
}