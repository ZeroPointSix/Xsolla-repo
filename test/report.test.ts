import { describe, expect, it } from "vitest";
import { markdownReport } from "../src/report.js";

const untruncated = { truncated: false, capturedBytes: 0, omittedBytes: 0 };

describe("markdownReport", () => {
  it("lists changed files and validation outcomes", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [{ path: "src/index.ts", status: "modified" }],
      validationResults: [
        {
          command: "npm test",
          status: "failed",
          exitCode: 3,
          stdout: "standard output",
          stderr: "standard error",
          stdoutTruncation: { ...untruncated, capturedBytes: 15 },
          stderrTruncation: { ...untruncated, capturedBytes: 14 },
        },
      ],
    });

    expect(report).toContain("src/index.ts (modified)");
    expect(report).toContain("npm test");
    expect(report).toContain("- Status: failed");
    expect(report).toContain("- Exit code: 3");
    expect(report).toContain("#### stdout");
    expect(report).toContain("standard output");
    expect(report).toContain("#### stderr");
    expect(report).toContain("standard error");
  });

  it("renders renamed and copied files as separate source and destination paths", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [
        { path: "new", previousPath: "old", status: "renamed" },
        { path: "copy new", previousPath: "copy old", status: "copied" },
      ],
      validationResults: [],
    });

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

  it("reports timeout and stream-truncation diagnostics", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [],
      validationResults: [
        {
          command: "npm test",
          status: "timed_out",
          exitCode: null,
          timeoutMs: 60_000,
          terminationError: "taskkill exited with code 5; descendant cleanup cannot be confirmed.",
          stdout: "stdout head\n[... 900 bytes omitted ...]\nstdout tail",
          stderr: "",
          stdoutTruncation: {
            truncated: true,
            capturedBytes: 124,
            omittedBytes: 900,
          },
          stderrTruncation: untruncated,
        },
      ],
    });

    expect(report).toContain("- Status: timed_out");
    expect(report).toContain("- Timeout: exceeded 60000 ms.");
    expect(report).toContain(
      "- Termination cleanup: taskkill exited with code 5; descendant cleanup cannot be confirmed.",
    );
    expect(report).toContain(
      "- stdout truncated: retained 124 source bytes and omitted 900 source bytes.",
    );
    expect(report).toContain("[... 900 bytes omitted ...]");
  });
});
