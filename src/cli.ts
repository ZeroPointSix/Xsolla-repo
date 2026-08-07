#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { CliUsageError, parseArgs, USAGE } from "./cli-args.js";
import { reviewRepository } from "./core.js";
import { jsonReport, markdownReport } from "./report.js";
import { VERSION } from "./version.js";

function defaultOutputPath(format: "markdown" | "json"): string {
  return format === "json" ? "review-report.json" : "review-report.md";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.command !== "review" || !args.repositoryPath) {
    throw new CliUsageError("The review command requires --repo <path>.");
  }

  const result = await reviewRepository(
    {
      repositoryPath: args.repositoryPath,
      baseRef: args.baseRef,
      validationCommands: args.validations,
    },
    {
      validationTimeoutMs: args.timeoutMs,
      maxOutputBytes: args.maxOutputBytes,
    },
  );
  const report = args.format === "json" ? jsonReport(result) : markdownReport(result);
  const outputPath = args.outputPath ?? defaultOutputPath(args.format);

  if (outputPath === "-") {
    process.stdout.write(report);
  } else {
    writeFileSync(outputPath, report, "utf8");
    console.log(`Review report written to ${outputPath}`);
  }

  if (result.summary.failed + result.summary.timedOut + result.summary.errors > 0) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (error instanceof CliUsageError) console.error(`\n${USAGE}`);
  process.exitCode = 1;
});
