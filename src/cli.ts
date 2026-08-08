#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { CliUsageError, parseArgs, usage } from "./args.js";
import { reviewRepository } from "./core.js";
import { markdownReport } from "./report.js";

const VERSION = "2.0.0";

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
  const outputFile = format === "json" ? "review-report.json" : "review-report.md";
  const output =
    format === "json" ? `${JSON.stringify(result, null, 2)}\n` : markdownReport(result);

  writeFileSync(outputFile, output, "utf8");
  console.log(`Review report written to ${outputFile}`);
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    console.error(`${error.message}\n\n${usage()}`);
  } else {
    console.error("Fatal error:", error);
  }
  process.exitCode = 1;
});
