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
  default:
    throw new Error(`Unsupported fixture mode: ${mode}`);
}
