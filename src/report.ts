import type { ChangedFile, ValidationOutputTruncation, ValidationResult } from "./types.js";

type ReportInput = {
  repositoryPath: string;
  changedFiles: ChangedFile[];
  validationResults: ValidationResult[];
};

function truncationDiagnostic(
  stream: "stdout" | "stderr",
  truncation: ValidationOutputTruncation,
): string | undefined {
  if (!truncation.truncated) {
    return undefined;
  }

  return `- ${stream} truncated: retained ${truncation.capturedBytes} source bytes and omitted ${truncation.omittedBytes} source bytes.`;
}

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
    if (result.status === "timed_out" && result.timeoutMs) {
      lines.push(`- Timeout: exceeded ${result.timeoutMs} ms.`);
    }
    const stdoutDiagnostic = truncationDiagnostic("stdout", result.stdoutTruncation);
    if (stdoutDiagnostic) {
      lines.push(stdoutDiagnostic);
    }
    lines.push("#### stdout", "```", result.stdout, "```");
    const stderrDiagnostic = truncationDiagnostic("stderr", result.stderrTruncation);
    if (stderrDiagnostic) {
      lines.push(stderrDiagnostic);
    }
    lines.push("#### stderr", "```", result.stderr, "```");
    if (result.error) {
      lines.push("- Execution error:", "```", result.error, "```");
    }
  }
  return lines.join("\n");
}
