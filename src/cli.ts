#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { CliUsageError, parseArgs, usage } from "./args.js";
import { reviewRepository } from "./core.js";
import { markdownReport } from "./report.js";

const VERSION = "2.0.0";

class ReportWriteError extends Error {
  constructor(outputPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Unable to write review report to ${outputPath}: ${detail}`);
    this.name = "ReportWriteError";
  }
}

function writeReport(outputPath: string, output: string): void {
  try {
    writeFileSync(outputPath, output, "utf8");
  } catch (error) {
    throw new ReportWriteError(outputPath, error);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.kind === "help") {
    console.log(usage());
    return;
  }
  if (args.kind === "version") {
    console.log(VERSION);
    return;
  }

  const result = await reviewRepository({
    repositoryPath: args.repositoryPath,
    baseRef: args.baseRef,
    validationCommands: args.validations,
  });
  const format = args.format ?? "markdown";
  const outputPath =
    args.outputPath ?? (format === "json" ? "review-report.json" : "review-report.md");
  const output =
    format === "json" ? `${JSON.stringify(result, null, 2)}\n` : markdownReport(result);

  if (outputPath === "-") {
    process.stdout.write(output);
    return;
  }

  writeReport(outputPath, output);
  console.log(`Review report written to ${outputPath}`);
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    console.error(`${error.message}\n\n${usage()}`);
  } else if (error instanceof ReportWriteError) {
    console.error(error.message);
  } else {
    console.error("Fatal error:", error);
  }
  process.exitCode = 1;
});
