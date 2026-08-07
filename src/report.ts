import type {
  ChangedFile,
  ReviewResult,
  ValidationOutputTruncation,
  ValidationResult,
} from "./types.js";

const validationStatuses = ["passed", "failed", "error", "timed_out"] as const;

function truncationDiagnostic(
  stream: "stdout" | "stderr",
  truncation: ValidationOutputTruncation,
): string | undefined {
  if (!truncation.truncated) {
    return undefined;
  }

  return `- ${stream} truncated: retained ${truncation.capturedBytes} source bytes and omitted ${truncation.omittedBytes} source bytes.`;
}

const markdownPathMetacharacters = new Set([
  "\\",
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "<",
  ">",
  "(",
  ")",
  "#",
  "+",
  "!",
  "&",
  "|",
  "~",
]);

function escapedControlCharacter(character: string): string | undefined {
  switch (character) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
  }

  if (/\p{Cc}|\p{Zl}|\p{Zp}/u.test(character)) {
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  }
  return undefined;
}

/** Formats an arbitrary filesystem path as one safe Markdown text fragment. */
function formatMarkdownPath(path: string): string {
  return Array.from(path, (character) => {
    const escapedControl = escapedControlCharacter(character);
    if (escapedControl) {
      return escapedControl;
    }
    return markdownPathMetacharacters.has(character) ? `\\${character}` : character;
  }).join("");
}

function changedFileLine(file: ChangedFile): string {
  const path = formatMarkdownPath(file.path);
  if (file.status === "renamed" || file.status === "copied") {
    return `${file.status}: ${formatMarkdownPath(file.previousPath)} → ${path}`;
  }
  return `${path} (${file.status})`;
}

function backtickFence(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function inlineCode(value: string): string {
  const fence = backtickFence(value);
  return `${fence} ${value} ${fence}`;
}

function fencedCodeBlock(value: string): string {
  const fence = backtickFence(value);
  return `${fence}\n${value}\n${fence}`;
}

function validationSummary(results: ValidationResult[]): string {
  const counts = Object.fromEntries(
    validationStatuses.map((status) => [status, 0]),
  ) as Record<ValidationResult["status"], number>;

  for (const result of results) {
    counts[result.status] += 1;
  }

  return `- Validation results: ${results.length} total (passed: ${counts.passed}, failed: ${counts.failed}, error: ${counts.error}, timed_out: ${counts.timed_out})`;
}

export function markdownReport(input: ReviewResult): string {
  const lines = [
    "# Review Report",
    "",
    "## Summary",
    `- Changed files: ${input.changedFiles.length}`,
    validationSummary(input.validationResults),
    "",
    "## Changed files",
  ];
  if (input.changedFiles.length === 0) {
    lines.push("No changed files detected.");
  } else {
    for (const file of input.changedFiles) {
      lines.push(`- ${changedFileLine(file)}`);
    }
  }

  lines.push("", "## Validation output");
  if (input.validationResults.length === 0) {
    lines.push("No validation commands were run.");
  } else {
    for (const result of input.validationResults) {
      lines.push(
        `### Command: ${inlineCode(result.command)}`,
        `- Status: ${result.status}`,
        `- Exit code: ${result.exitCode ?? "unavailable"}`,
      );
      if (result.signal) {
        lines.push(`- Signal: ${result.signal}`);
      }
      if (result.status === "timed_out" && result.timeoutMs) {
        lines.push(`- Timeout: exceeded ${result.timeoutMs} ms.`);
      }
      if (result.terminationError) {
        lines.push(`- Termination cleanup: ${result.terminationError}`);
      }
      const stdoutDiagnostic = truncationDiagnostic("stdout", result.stdoutTruncation);
      if (stdoutDiagnostic) {
        lines.push(stdoutDiagnostic);
      }
      lines.push("#### stdout", fencedCodeBlock(result.stdout));
      const stderrDiagnostic = truncationDiagnostic("stderr", result.stderrTruncation);
      if (stderrDiagnostic) {
        lines.push(stderrDiagnostic);
      }
      lines.push("#### stderr", fencedCodeBlock(result.stderr));
      if (result.error) {
        lines.push("- Execution error:", fencedCodeBlock(result.error));
      }
    }
  }
  return lines.join("\n");
}
