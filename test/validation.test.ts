import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidation, runValidations } from "../src/validation.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inspector-validation-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runValidation", () => {
  it("returns failed results without throwing", async () => {
    const result = await runValidation(
      `${process.execPath} -e "process.stderr.write('bad'); process.exit(3)"`,
      temporaryDirectory(),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("bad");
  });

  it("marks a command as timed out", async () => {
    const result = await runValidation(
      `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      temporaryDirectory(),
      { timeoutMs: 30, maxOutputBytes: 1024 },
    );

    expect(result.status).toBe("timeout");
  });

  it("bounds large output and records truncation", async () => {
    const result = await runValidation(
      `${process.execPath} -e "process.stdout.write('x'.repeat(10000))"`,
      temporaryDirectory(),
      { timeoutMs: 5000, maxOutputBytes: 512 },
    );

    expect(result.status).toBe("passed");
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("truncated");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(700);
  });

  it("does not interpret shell command separators", async () => {
    const directory = temporaryDirectory();
    const marker = join(directory, "shell-ran");
    await runValidation(
      `${process.execPath} -e "process.exit(0)"; ${process.execPath} -e "require('node:fs').writeFileSync('${marker}', 'bad')"`,
      directory,
    );

    expect(existsSync(marker)).toBe(false);
  });

  it("continues after one validation fails", async () => {
    const results = await runValidations(
      [
        `${process.execPath} -e "process.exit(1)"`,
        `${process.execPath} -e "process.stdout.write('continued')"`,
      ],
      temporaryDirectory(),
    );

    expect(results.map((result) => result.status)).toEqual(["failed", "passed"]);
    expect(results[1].stdout).toBe("continued");
  });
});

