import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
  });
}

describe("CLI", () => {
  it.each([
    [["--help"], "Usage: inspector review"],
    [["review", "--help"], "Usage: inspector review"],
    [["--version"], "2.0.0"],
    [["review", "--version"], "2.0.0"],
  ])("exits successfully for %j without --repo", (args, expectedOutput) => {
    const result = runCli(...args);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
    expect(result.stderr).toBe("");
  });

  it("exits nonzero for usage errors", () => {
    const result = runCli("review", "--repo", "--base-ref", "main");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--repo requires a value.");
    expect(result.stderr).toContain("Usage: inspector review");
  });
});
