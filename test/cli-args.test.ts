import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../src/cli-args.js";

describe("parseArgs", () => {
  it("preserves repository paths that contain spaces", () => {
    const args = parseArgs(["review", "--repo", "/tmp/My Project"]);
    expect(args.repositoryPath).toBe("/tmp/My Project");
  });

  it("rejects a missing option value", () => {
    expect(() => parseArgs(["review", "--repo", "--format", "json"])).toThrow(
      CliUsageError,
    );
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["review", "--repo", "/tmp/repo", "--wat"])).toThrow(
      /Unknown option/,
    );
  });

  it("validates the output format", () => {
    expect(() =>
      parseArgs(["review", "--repo", "/tmp/repo", "--format", "xml"]),
    ).toThrow(/format/);
  });
});

