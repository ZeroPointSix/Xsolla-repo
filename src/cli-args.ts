export type OutputFormat = "markdown" | "json";

export type CliArgs = {
  command: string;
  repositoryPath?: string;
  baseRef?: string;
  format: OutputFormat;
  validations: string[];
  outputPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  help: boolean;
  version: boolean;
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new CliUsageError(`${option} must be a positive integer.`);
  }
  return number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? "",
    format: "markdown",
    validations: [],
    help: false,
    version: false,
  };

  if (args.command === "--help" || args.command === "-h") {
    args.help = true;
    args.command = "";
    return args;
  }
  if (args.command === "--version" || args.command === "-v") {
    args.version = true;
    args.command = "";
    return args;
  }

  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    switch (token) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--repo":
        args.repositoryPath = optionValue(argv, index, token);
        index++;
        break;
      case "--base-ref":
        args.baseRef = optionValue(argv, index, token);
        index++;
        break;
      case "--format": {
        const value = optionValue(argv, index, token);
        if (value !== "markdown" && value !== "json") {
          throw new CliUsageError("--format must be 'markdown' or 'json'.");
        }
        args.format = value;
        index++;
        break;
      }
      case "--validate":
        args.validations.push(optionValue(argv, index, token));
        index++;
        break;
      case "--output":
        args.outputPath = optionValue(argv, index, token);
        index++;
        break;
      case "--timeout-ms":
        args.timeoutMs = positiveInteger(optionValue(argv, index, token), token);
        index++;
        break;
      case "--max-output-bytes":
        args.maxOutputBytes = positiveInteger(optionValue(argv, index, token), token);
        index++;
        break;
      default:
        if (token.startsWith("-")) {
          throw new CliUsageError(`Unknown option: ${token}`);
        }
        throw new CliUsageError(`Unexpected argument: ${token}`);
    }
  }

  return args;
}

export const USAGE = `Usage:
  inspector review --repo <path> [options]

Options:
  --base-ref <ref>          Base branch, tag, or commit. Auto-detected by default.
  --validate <command>      Run a command without a shell. May be repeated.
  --format <markdown|json>  Output format. Default: markdown.
  --output <path|->         Output file, or '-' for stdout.
  --timeout-ms <number>     Per-command timeout. Default: 60000.
  --max-output-bytes <n>    Per-stream output limit. Default: 262144.
  --help                    Show this help.
  --version                 Show the version.`;

