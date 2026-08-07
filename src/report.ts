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

export function markdownReport(input: ReportInput): string {
  const lines = [
    `# Review Report: ${formatMarkdownPath(input.repositoryPath)}`,
    "",
    "## Changed files",
  ];
  for (const file of input.changedFiles) {
    lines.push(`- ${changedFileLine(file)}`);
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
    if (result.terminationError) {
      lines.push(`- Termination cleanup: ${result.terminationError}`);
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
