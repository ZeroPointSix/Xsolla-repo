#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function tarText(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim();
}

function tarSize(header) {
  const rawSize = tarText(header, 124, 12);
  if (rawSize === "") {
    return 0;
  }

  const size = Number.parseInt(rawSize, 8);
  assert(Number.isSafeInteger(size) && size >= 0, `Invalid tar entry size: ${rawSize}`);
  return size;
}

function paxAttributes(data) {
  const attributes = new Map();
  let offset = 0;

  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    assert.notEqual(space, -1, "Invalid PAX header length.");
    const recordLength = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    assert(Number.isSafeInteger(recordLength) && recordLength > 0, "Invalid PAX record length.");
    const recordEnd = offset + recordLength;
    assert(recordEnd <= data.length, "Truncated PAX header.");

    const record = data.subarray(space + 1, recordEnd - 1).toString("utf8");
    const equals = record.indexOf("=");
    assert.notEqual(equals, -1, "Invalid PAX record.");
    attributes.set(record.slice(0, equals), record.slice(equals + 1));
    offset = recordEnd;
  }

  return attributes;
}

function tarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = [];
  let offset = 0;
  let nextPath;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = tarSize(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert(dataEnd <= archive.length, "Truncated tar entry.");

    const type = String.fromCharCode(header[156] || 0);
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const data = archive.subarray(dataStart, dataEnd);

    if (type === "x" || type === "g") {
      const attributes = paxAttributes(data);
      if (attributes.has("path")) {
        nextPath = attributes.get("path");
      }
    } else if (type === "L") {
      nextPath = data.toString("utf8").replace(/\0.*$/, "");
    } else {
      entries.push(nextPath ?? headerPath);
      nextPath = undefined;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function declaredBinTarget(packageJson) {
  const bin = packageJson.bin;
  const target = typeof bin === "string" ? bin : bin?.inspector;
  assert.equal(typeof target, "string", "package.json must declare the inspector bin target.");
  return target;
}

async function createRepository(root) {
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);

  run("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
  run("git", ["config", "user.email", "smoke@example.com"], { cwd: repositoryPath });
  run("git", ["config", "user.name", "Smoke Test"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repositoryPath });
  run("git", ["commit", "-m", "Initial commit"], { cwd: repositoryPath });

  await writeFile(join(repositoryPath, "added-by-smoke.txt"), "added\n");
  run("git", ["add", "added-by-smoke.txt"], { cwd: repositoryPath });
  run("git", ["commit", "-m", "Add smoke fixture"], { cwd: repositoryPath });
  return repositoryPath;
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const binTarget = declaredBinTarget(packageJson);
  assert(existsSync(join(projectRoot, binTarget)), `Build output is missing: ${binTarget}`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "repository-inspector-cli-smoke-"));
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: process.env.npm_config_cache ?? join(temporaryRoot, "npm-cache"),
  };
  let tarballPath;
  try {
    const packResult = JSON.parse(
      run(npmCommand, ["pack", "--json"], { cwd: projectRoot, env: npmEnvironment }),
    );
    const tarballName = packResult[0]?.filename;
    assert.equal(typeof tarballName, "string", "npm pack did not return a tarball filename.");
    tarballPath = resolve(projectRoot, tarballName);
    assert(
      !relative(projectRoot, tarballPath).startsWith(".."),
      "npm pack returned a tarball outside the project root.",
    );

    const packedTarget = `package/${binTarget.replace(/^\.\//, "")}`;
    assert(
      tarEntries(tarballPath).includes(packedTarget),
      `Packed tarball is missing the declared bin target: ${packedTarget}`,
    );

    const installPrefix = join(temporaryRoot, "installed");
    await mkdir(installPrefix);
    run(
      npmCommand,
      ["install", "--prefix", installPrefix, "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
      { cwd: projectRoot, env: npmEnvironment },
    );

    const inspector = join(
      installPrefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "inspector.cmd" : "inspector",
    );
    assert(existsSync(inspector), "Installed package did not expose the inspector executable.");
    const help = run(inspector, ["review", "--help"], { cwd: temporaryRoot });
    assert.match(help, /Usage: inspector review/, "Installed inspector did not return its help text.");

    const repositoryPath = await createRepository(temporaryRoot);
    const reportPath = join(temporaryRoot, "review-report.json");
    run(
      inspector,
      [
        "review",
        "--repo",
        repositoryPath,
        "--base-ref",
        "HEAD~1",
        "--format",
        "json",
        "--output",
        reportPath,
      ],
      { cwd: temporaryRoot },
    );

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.changedFiles, [
      { path: "added-by-smoke.txt", status: "added" },
    ]);
  } finally {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      tarballPath ? rm(tarballPath, { force: true }) : Promise.resolve(),
    ]);
  }
}

await main();
