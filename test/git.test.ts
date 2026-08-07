import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRepository, parseNameStatus } from "../src/git.js";

const directories: string[] = [];

function git(repositoryPath: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "ignore" });
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "inspector-git-"));
  directories.push(directory);
  git(directory, "init", "-b", "master");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Test User");
  writeFileSync(join(directory, "old name.ts"), "export const value = 1;\n");
  git(directory, "add", ".");
  git(directory, "commit", "-m", "initial");
  git(directory, "switch", "-c", "feature");
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseNameStatus", () => {
  it("preserves rename, copy, and unusual paths", () => {
    const files = parseNameStatus(
      "R100\0old name.ts\0new name.ts\0C75\0a.ts\0b.ts\0M\0src/\\u4e2d\\u6587 file.ts\0",
    );

    expect(files).toEqual([
      { path: "new name.ts", previousPath: "old name.ts", status: "renamed" },
      { path: "b.ts", previousPath: "a.ts", status: "copied" },
      { path: "src/\\u4e2d\\u6587 file.ts", status: "modified" },
    ]);
  });
});

describe("inspectRepository", () => {
  it("detects a master base, renames, and untracked files", () => {
    const directory = repository();
    git(directory, "mv", "old name.ts", "new name.ts");
    git(directory, "commit", "-am", "rename");
    writeFileSync(join(directory, "untracked file.ts"), "new file\n");

    const result = inspectRepository(directory);

    expect(result.baseRef).toBe("master");
    expect(result.changedFiles).toContainEqual({
      path: "new name.ts",
      previousPath: "old name.ts",
      status: "renamed",
    });
    expect(result.changedFiles).toContainEqual({
      path: "untracked file.ts",
      status: "untracked",
    });
  });

  it("rejects ref values that could be parsed as options", () => {
    expect(() => inspectRepository(repository(), "--upload-pack=x")).toThrow(
      /must not start/,
    );
  });

  it("returns a readable error for a non-git directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "inspector-not-git-"));
    directories.push(directory);
    expect(() => inspectRepository(directory)).toThrow(/not a Git repository/);
  });
});

