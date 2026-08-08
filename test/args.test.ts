import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("preserves the repository argument verbatim", () => {
    const repositoryPath = "/Users/me/My Projects/app";

    expect(parseArgs(["review", "--repo", repositoryPath])).toEqual({
      kind: "review",
      repositoryPath,
      validations: [],
    });
  });

  it("parses review options", () => {
    expect(
      parseArgs([
        "review",
        "--repo",
        "/work/repository",
        "--base-ref",
        "main",
        "--format",
        "markdown",
        "--validate",
        "npm test",
        "--validate",
        "npm run typecheck",
      ]),
    ).toEqual({
      kind: "review",
      repositoryPath: "/work/repository",
      baseRef: "main",
      format: "markdown",
      validations: ["npm test", "npm run typecheck"],
    });
  });

  it.each(["--repo", "--base-ref", "--format", "--validate"])(
    "rejects a missing value for %s",
    (flag) => {
      expect(() => parseArgs(["review", flag])).toThrow(CliUsageError);
      expect(() => parseArgs(["review", flag, "--repo"])).toThrow(
        `${flag} requires a value.`,
      );
    },
  );

  it("rejects unknown commands and arguments", () => {
    expect(() => parseArgs(["inspect"])).toThrow("Unknown command: inspect.");
    expect(() => parseArgs(["review", "--repo", "/work/repository", "--wat"])).toThrow(
      "Unknown argument: --wat.",
    );
  });

  it("only accepts markdown or json formats", () => {
    expect(() => parseArgs(["review", "--repo", "/work/repository", "--format", "html"])).toThrow(
      "--format must be either markdown or json.",
    );
    expect(parseArgs(["review", "--repo", "/work/repository", "--format", "json"])).toMatchObject({
      format: "json",
    });
  });

  it.each([
    [["--help"], { kind: "help" }],
    [["review", "--help"], { kind: "help" }],
    [["--version"], { kind: "version" }],
    [["review", "--version"], { kind: "version" }],
  ] as const)("parses %j without requiring --repo", (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });
});
