import { describe, expect, it } from "vitest";
import { markdownReport } from "../src/report.js";
import type { ValidationResult } from "../src/types.js";

const untruncated = { truncated: false, capturedBytes: 0, omittedBytes: 0 };

function validationResult(
  overrides: Partial<ValidationResult> = {},
): ValidationResult {
  return {
    command: "npm test",
    status: "passed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncation: untruncated,
    stderrTruncation: untruncated,
    ...overrides,
  };
}

describe("markdownReport", () => {
  it("renders summary counts and an explicit no-changes message", () => {
    const report = markdownReport({
      repositoryPath: "/private/workspace/sample",
      changedFiles: [],
      validationResults: [],
    });

    expect(report).toContain("- Changed files: 0");
    expect(report).toContain(
      "- Validation results: 0 total (passed: 0, failed: 0, error: 0, timed_out: 0)",
    );
    expect(report).toContain("No changed files detected.");
    expect(report).toContain("No validation commands were run.");
  });

  it("does not include the repository path in the report title", () => {
    const report = markdownReport({
      repositoryPath: "/private/workspace/sample",
      changedFiles: [],
      validationResults: [],
    });

    expect(report).toMatch(/^# Review Report\n/);
    expect(report).not.toContain("/private/workspace/sample");
  });

  it("lists changed files and renders renamed and copied source paths", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [
        { path: "src/index.ts", status: "modified" },
        { path: "new", previousPath: "old", status: "renamed" },
        { path: "copy new", previousPath: "copy old", status: "copied" },
      ],
      validationResults: [],
    });

    expect(report).toContain("- Changed files: 3");
    expect(report).toContain("- src/index.ts (modified)");
    expect(report).toContain("- renamed: old → new");
    expect(report).toContain("- copied: copy old → copy new");
    expect(report).not.toContain("old\tnew");
  });

  it("escapes control and Markdown characters in every changed-file path", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [
        { path: "normal\n- forged\t`file`[name]", status: "modified" },
        {
          path: "renamed\n- destination",
          previousPath: "old\t`source`[name]",
          status: "renamed",
        },
        {
          path: "copied\t`destination`[name]",
          previousPath: "copy\n- forged source",
          status: "copied",
        },
        { path: "\\`*_{}[]<>()#+!&|~", status: "added" },
      ],
      validationResults: [],
    });

    expect(report).toContain("- normal\\n- forged\\t\\`file\\`\\[name\\] (modified)");
    expect(report).toContain(
      "- renamed: old\\t\\`source\\`\\[name\\] → renamed\\n- destination",
    );
    expect(report).toContain(
      "- copied: copy\\n- forged source → copied\\t\\`destination\\`\\[name\\]",
    );
    expect(report).not.toContain("\n- forged");
    expect(report).not.toContain("\n- destination");
    expect(report).not.toContain("\n- forged source");
    for (const character of "\\`*_{}[]<>()#+!&|~") {
      expect(report).toContain(`\\${character}`);
    }
  });

  it("renders every validation status and its diagnostics", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [],
      validationResults: [
        validationResult({ command: "pass", status: "passed", exitCode: 0 }),
        validationResult({
          command: "fail",
          status: "failed",
          exitCode: 3,
          signal: "SIGTERM",
        }),
        validationResult({
          command: "error",
          status: "error",
          exitCode: null,
          error: "Unable to start command.",
        }),
        validationResult({
          command: "timeout",
          status: "timed_out",
          exitCode: null,
          timeoutMs: 60_000,
          terminationError:
            "taskkill exited with code 5; descendant cleanup cannot be confirmed.",
          stdout: "stdout head\n[... 900 bytes omitted ...]\nstdout tail",
          stderr: "standard error",
          stdoutTruncation: {
            truncated: true,
            capturedBytes: 124,
            omittedBytes: 900,
          },
          stderrTruncation: {
            truncated: true,
            capturedBytes: 14,
            omittedBytes: 21,
          },
        }),
      ],
    });

    expect(report).toContain(
      "- Validation results: 4 total (passed: 1, failed: 1, error: 1, timed_out: 1)",
    );
    for (const status of ["passed", "failed", "error", "timed_out"]) {
      expect(report).toContain(`- Status: ${status}`);
    }
    expect(report).toContain("- Exit code: 0");
    expect(report).toContain("- Exit code: 3");
    expect(report).toContain("- Exit code: unavailable");
    expect(report).toContain("- Signal: SIGTERM");
    expect(report).toContain("- Timeout: exceeded 60000 ms.");
    expect(report).toContain(
      "- Termination cleanup: taskkill exited with code 5; descendant cleanup cannot be confirmed.",
    );
    expect(report).toContain(
      "- stdout truncated: retained 124 source bytes and omitted 900 source bytes.",
    );
    expect(report).toContain(
      "- stderr truncated: retained 14 source bytes and omitted 21 source bytes.",
    );
    expect(report).toContain("- Execution error:");
    expect(report).toContain("Unable to start command.");
  });

  it("uses fences longer than stdout and stderr backtick runs", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [],
      validationResults: [
        validationResult({
          stdout: "opening\n```\nclosing",
          stderr: "``````",
        }),
      ],
    });
    const lines = report.split("\n");
    const stdoutHeading = lines.indexOf("#### stdout");
    const stderrHeading = lines.indexOf("#### stderr");

    expect(lines[stdoutHeading + 1]).toBe("````");
    expect(lines[stdoutHeading + 5]).toBe("````");
    expect(lines[stderrHeading + 1]).toBe("```````");
    expect(lines[stderrHeading + 3]).toBe("```````");
    expect(report).toContain("\n```\n");
    expect(report).toContain("\n``````\n");
  });

  it("renders command labels with Markdown punctuation as inline code", () => {
    const command = "npm run `preview` [safe] *";
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [],
      validationResults: [validationResult({ command })],
    });

    expect(report).toContain(`### Command: \`\`\` ${command} \`\`\``);
    expect(report).not.toContain(`### ${command}`);
  });
});
