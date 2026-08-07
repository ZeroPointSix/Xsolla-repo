#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpServerPath = join(projectRoot, "dist", "mcp-server.js");
const repositoryRootEnvironment = "REPOSITORY_INSPECTOR_MCP_ROOT";

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

  await writeFile(join(repositoryPath, "added-by-mcp-smoke.txt"), "added\n");
  run("git", ["add", "added-by-mcp-smoke.txt"], { cwd: repositoryPath });
  run("git", ["commit", "-m", "Add MCP smoke fixture"], { cwd: repositoryPath });
  return repositoryPath;
}

function changedFilesFrom(result) {
  assert.equal(typeof result, "object", "MCP review did not return a tool result.");
  assert.notEqual(result, null, "MCP review did not return a tool result.");
  assert.notEqual(result.isError, true, "MCP review returned an error.");
  assert.equal(typeof result.structuredContent, "object", "MCP review did not return structured content.");
  assert.notEqual(result.structuredContent, null, "MCP review did not return structured content.");
  assert(Array.isArray(result.structuredContent.changedFiles), "MCP result is missing changedFiles.");
  return result.structuredContent.changedFiles;
}

async function main() {
  assert(existsSync(mcpServerPath), `Build output is missing: ${mcpServerPath}`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "repository-inspector-mcp-smoke-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: projectRoot,
    env: {
      ...process.env,
      [repositoryRootEnvironment]: temporaryRoot,
    },
  });
  const client = new Client({ name: "repository-inspector-mcp-smoke", version: "1.0.0" });
  let connected = false;

  try {
    const repositoryPath = await createRepository(temporaryRoot);
    await client.connect(transport);
    connected = true;

    const result = await client.callTool({
      name: "review_repository",
      arguments: {
        repo_path: repositoryPath,
        base_ref: "HEAD~1",
      },
    });

    assert.deepEqual(changedFilesFrom(result), [
      { path: "added-by-mcp-smoke.txt", status: "added" },
    ]);
  } finally {
    try {
      if (connected) {
        await client.close();
      } else {
        await transport.close();
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

await main();
