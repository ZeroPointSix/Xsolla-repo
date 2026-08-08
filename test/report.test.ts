import { describe, expect, it } from "vitest";
import { markdownReport } from "../src/report.js";

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
});