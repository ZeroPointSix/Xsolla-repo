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
      "- stdout truncated: retained 124 source bytes and omitted 900 source bytes.",
    );
    expect(report).toContain("[... 900 bytes omitted ...]");
  });
});
