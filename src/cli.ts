#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { CliUsageError, parseArgs, usage } from "./args.js";
import { reviewRepository } from "./core.js";

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

  const report = await reviewRepository({
    repositoryPath: args.repositoryPath,
    baseRef: args.baseRef,
    validationCommands: args.validations,
    format: args.format,
  });
  writeFileSync("review-report.md", report, "utf8");
  console.log("Review report written to review-report.md");
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    console.error(`${error.message}\n\n${usage()}`);
  } else {
    console.error("Fatal error:", error);
  }
  process.exitCode = 1;
});
