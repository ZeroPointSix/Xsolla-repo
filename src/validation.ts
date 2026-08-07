import { spawn } from "node:child_process";
import type { ValidationResult } from "./types.js";

export class ValidationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCommandError";
  }
}

const unsupportedShellSyntax: Record<string, string> = {
  ";": "command separators",
  "|": "pipelines",
  "&": "shell operators",
  "<": "redirections",
  ">": "redirections",
  "(": "shell grouping",
  ")": "shell grouping",
  "{": "shell expansion",
  "}": "shell expansion",
  "*": "globbing",
  "?": "globbing",
  "[": "globbing",
  "]": "globbing",
  "#": "comments",
  "~": "home-directory expansion",
};

function rejectUnsupportedSyntax(character: string): never {
  throw new ValidationCommandError(
    `Validation commands do not support ${unsupportedShellSyntax[character]} (${character}).`,
  );
}

/**
 * Splits a deliberately small command-string grammar into an executable and
 * arguments. Quoted arguments may contain spaces and literal shell characters;
 * shell grammar itself is rejected because validation commands never use a shell.
 */
export function tokenizeValidationCommand(command: string): string[] {
  const args: string[] = [];
  let argument = "";
  let argumentStarted = false;
  let quote: "'" | '"' | undefined;

  for (const character of command) {
    if (character === "\n" || character === "\r") {
      throw new ValidationCommandError("Validation commands must not contain newlines.");
    }

    if (character === "$" || character === "`") {
      throw new ValidationCommandError(
        "Validation commands do not support shell substitutions or expansions.",
      );
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        argument += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      argumentStarted = true;
      continue;
    }

    if (character === " " || character === "\t") {
      if (argumentStarted) {
        args.push(argument);
        argument = "";
        argumentStarted = false;
      }
      continue;
    }

    if (character in unsupportedShellSyntax) {
      rejectUnsupportedSyntax(character);
    }

    argument += character;
    argumentStarted = true;
  }

  if (quote === "'") {
    throw new ValidationCommandError("Validation command has an unterminated single-quoted argument.");
  }
  if (quote === '"') {
    throw new ValidationCommandError("Validation command has an unterminated double-quoted argument.");
  }
  if (argumentStarted) {
    args.push(argument);
  }
  if (args.length === 0) {
    throw new ValidationCommandError("Validation command must not be empty.");
  }

  return args;
}

export async function runValidation(command: string, cwd: string): Promise<ValidationResult> {
  const [file, ...args] = tokenizeValidationCommand(command);

  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: ValidationResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      settle({
        command,
        status: "error",
        exitCode: null,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.once("close", (code) => {
      settle({
        command,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

export async function runValidations(commands: string[], cwd: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd));
  }
  return results;
}
