import { describe, expect, it } from "vitest";
import { jsonReport, markdownReport } from "../src/report.js";
import type { ReviewResult } from "../src/types.js";

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    repository: {
      name: "sample",
      path: "/work/sample",
      baseRef: "main",
    },
    changedFiles: [],
    validationResults: [],
    summary: {
      changedFiles: 0,
      validations: 0,
      passed: 0,
      failed: 0,
      timedOut: 0,
      errors: 0,
    },
    ...overrides,
  };
}

describe("markdownReport", () => {
  it("shows empty sections and validation status", () => {
    const report = markdownReport(
      result({
        validationResults: [
          {
            command: "npm test",
            status: "failed",
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "failed output",
            durationMs: 12,
            truncated: false,
          },
        ],
        summary: {
          changedFiles: 0,
          validations: 1,
          passed: 0,
          failed: 1,
          timedOut: 0,
          errors: 0,
        },
      }),
    );

    expect(report).toContain("No changes found.");
    expect(report).toContain("Status: failed");
    expect(report).toContain("Exit code: 2");
  });

  it("uses a fence longer than backticks in command output", () => {
    const report = markdownReport(
      result({
        validationResults: [
          {
            command: "print-markdown",
            status: "passed",
            exitCode: 0,
            signal: null,
            stdout: "before\n```\nafter",
            stderr: "",
            durationMs: 1,
            truncated: false,
          },
        ],
      }),
    );

    expect(report).toContain("````\nbefore\n```\nafter\n````");
  });
});

describe("jsonReport", () => {
  it("returns the structured result", () => {
    expect(JSON.parse(jsonReport(result())).repository.name).toBe("sample");
  });
});
