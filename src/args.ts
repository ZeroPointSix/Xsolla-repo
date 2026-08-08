export type ReviewArgs = {
  kind: "review";
  repositoryPath: string;
  baseRef?: string;
  format?: "markdown" | "json";
  validations: string[];
};

export type ParsedArgs = ReviewArgs | { kind: "help" } | { kind: "version" };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === "--help") {
    return { kind: "help" };
  }
  if (argv[0] === "--version") {
    return { kind: "version" };
  }
  if (argv[0] !== "review") {
    throw new CliUsageError(`Unknown command: ${argv[0] ?? "(none)"}.`);
  }

  const args: ReviewArgs = { kind: "review", repositoryPath: "", validations: [] };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--help") {
      return { kind: "help" };
    }
    if (token === "--version") {
      return { kind: "version" };
    }
    if (token === "--repo") {
      args.repositoryPath = requiredValue(argv, index, token);
      index++;
    } else if (token === "--base-ref") {
      args.baseRef = requiredValue(argv, index, token);
      index++;
    } else if (token === "--format") {
      const format = requiredValue(argv, index, token);
      if (format !== "markdown" && format !== "json") {
        throw new CliUsageError("--format must be either markdown or json.");
      }
      args.format = format;
      index++;
    } else if (token === "--validate") {
      args.validations.push(requiredValue(argv, index, token));
      index++;
    } else {
      throw new CliUsageError(`Unknown argument: ${token}.`);
    }
  }

  if (!args.repositoryPath) {
    throw new CliUsageError("--repo requires a value.");
  }
  return args;
}

export function usage(): string {
  return [
    "Usage: inspector review --repo <path> [--base-ref <ref>] [--format <markdown|json>] [--validate <command>]...",
    "       inspector --help",
    "       inspector --version",
  ].join("\n");
}
