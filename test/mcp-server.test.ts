import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";

const temporaryRepositories: string[] = [];

function git(repositoryPath: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
}

function isTextContent(content: unknown): content is { type: "text"; text: string } {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    content.type === "text" &&
    "text" in content &&
    typeof content.text === "string"
  );
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "repository-inspector-"));
  temporaryRepositories.push(repositoryPath);

  git(repositoryPath, "init", "--initial-branch=main");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test User");
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, "add", "base.txt");
  git(repositoryPath, "commit", "-m", "Initial commit");

  git(repositoryPath, "switch", "--create", "feature");
  await writeFile(join(repositoryPath, "earlier-feature.txt"), "earlier\n");
  git(repositoryPath, "add", "earlier-feature.txt");
  git(repositoryPath, "commit", "-m", "Earlier feature commit");

  await writeFile(join(repositoryPath, "latest-feature.txt"), "latest\n");
  git(repositoryPath, "add", "latest-feature.txt");
  git(repositoryPath, "commit", "-m", "Latest feature commit");

  return repositoryPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((repositoryPath) =>
      rm(repositoryPath, { recursive: true, force: true }),
    ),
  );
});

describe("MCP server", () => {
  it("accepts the snake_case public request and maps optional fields", async () => {
    const repositoryPath = await createRepository();
    const server = createMcpServer();
    const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const reviewTool = tools.tools.find((tool) => tool.name === "review_repository");

      expect(reviewTool).toBeDefined();
      expect(reviewTool!.inputSchema.properties).toMatchObject({
        repo_path: { type: "string" },
        base_ref: { type: "string" },
        validation_commands: { type: "array" },
      });
      expect(reviewTool!.inputSchema.properties).not.toHaveProperty("baseRef");
      expect(reviewTool!.inputSchema.properties).not.toHaveProperty("validationCommands");

      const validationCommand = "node -e \"process.stdout.write('validation ran')\"";
      const result = await client.callTool({
        name: "review_repository",
        arguments: {
          repo_path: repositoryPath,
          base_ref: "HEAD~1",
          validation_commands: [validationCommand],
        },
      });

      if (!("content" in result) || !Array.isArray(result.content)) {
        throw new Error("Expected a standard MCP tool result.");
      }

      const text = result.content.find(isTextContent);

      expect(text).toBeDefined();
      expect(text!.text).toContain("latest-feature.txt (added)");
      expect(text!.text).not.toContain("earlier-feature.txt (added)");
      expect(text!.text).toContain(`### ${validationCommand}`);
      expect(text!.text).toContain("validation ran");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
