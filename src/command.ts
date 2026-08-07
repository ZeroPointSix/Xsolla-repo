export type ParsedCommand = {
  file: string;
  args: string[];
};

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

export function parseCommand(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let tokenStarted = false;

  const finishToken = () => {
    if (tokenStarted) {
      tokens.push(current);
      current = "";
      tokenStarted = false;
    }
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        escaped = true;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      finishToken();
    } else if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (character === "\\") {
      escaped = true;
      tokenStarted = true;
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (quote !== null) {
    throw new CommandParseError("Validation command has an unterminated quote.");
  }
  if (escaped) {
    throw new CommandParseError("Validation command ends with an incomplete escape.");
  }

  finishToken();
  if (tokens.length === 0) {
    throw new CommandParseError("Validation command must not be empty.");
  }

  return { file: tokens[0], args: tokens.slice(1) };
}

