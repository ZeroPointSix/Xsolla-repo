"use strict";

const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");

const [mode, ...args] = process.argv.slice(2);

function stayAlive(marker) {
  writeFileSync(marker, String(process.pid));
  process.on("SIGTERM", () => {
    appendFileSync(marker, "\nTERM");
  });
  setInterval(() => {}, 1_000);
}

function ignoreTerm(marker) {
  writeFileSync(marker, String(process.pid));
  process.on("SIGTERM", () => {
    appendFileSync(marker, "\nTERM-IGNORED");
  });
  setInterval(() => {}, 1_000);
}

function parentExitsOnTermWithDescendant(parentMarker, descendantMarker) {
  spawn(process.execPath, [__filename, "ignore-term", descendantMarker], {
    stdio: "ignore",
  });
  writeFileSync(parentMarker, String(process.pid));
  process.on("SIGTERM", () => {
    appendFileSync(parentMarker, "\nTERM");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
}

function writeLargeOutput(stream, name, size) {
  stream.write(`${name}-head\n`);
  let remaining = size;
  while (remaining > 0) {
    const chunkSize = Math.min(64, remaining);
    stream.write("x".repeat(chunkSize));
    remaining -= chunkSize;
  }
  stream.write(`\n${name}-tail\n`);
}

function writeUnicodeLargeOutput(stream, name, repetitions) {
  stream.write(`${name}-head-😀-漢\n`);
  for (let index = 0; index < repetitions; index += 1) {
    stream.write("😀é漢");
  }
  stream.write(`\n${name}-tail-😀-漢\n`);
}

function writeMalformedOutput(stream, name, repetitions = 1) {
  stream.write(Buffer.from(`${name}-head:`));
  stream.write(Buffer.alloc(repetitions, 0xff));
  stream.write(Buffer.from(`:${name}-tail`));
}

function writeGraphemeOutput(stream, name, repetitions) {
  const decomposed = "é";
  const zwjEmoji = "👩‍💻";
  const cjk = "漢字";
  stream.write(`${name}-head:${decomposed}:${zwjEmoji}:${cjk}\n`);
  for (let index = 0; index < repetitions; index += 1) {
    stream.write(`${decomposed}${zwjEmoji}${cjk}`);
  }
  stream.write(`\n${name}-tail:${decomposed}:${zwjEmoji}:${cjk}\n`);
}

switch (mode) {
  case "hang-with-descendant": {
    const [parentMarker, descendantMarker] = args;
    spawn(process.execPath, [__filename, "stay-alive", descendantMarker], {
      stdio: "ignore",
    });
    stayAlive(parentMarker);
    break;
  }
  case "stay-alive":
    stayAlive(args[0]);
    break;
  case "ignore-term":
    ignoreTerm(args[0]);
    break;
  case "parent-exits-on-term-with-descendant":
    parentExitsOnTermWithDescendant(args[0], args[1]);
    break;
  case "large-output": {
    const [stream, size] = args;
    writeLargeOutput(stream === "stderr" ? process.stderr : process.stdout, stream, Number(size));
    break;
  }
  case "unicode-large-output": {
    const [stream, repetitions] = args;
    writeUnicodeLargeOutput(
      stream === "stderr" ? process.stderr : process.stdout,
      stream,
      Number(repetitions),
    );
    break;
  }
  case "malformed-output": {
    const [stream, repetitions] = args;
    writeMalformedOutput(
      stream === "stderr" ? process.stderr : process.stdout,
      stream,
      Number(repetitions ?? "1"),
    );
    break;
  }
  case "grapheme-output": {
    const [stream, repetitions] = args;
    writeGraphemeOutput(
      stream === "stderr" ? process.stderr : process.stdout,
      stream,
      Number(repetitions),
    );
    break;
  }
  default:
    throw new Error(`Unsupported fixture mode: ${mode}`);
}
