import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_VALIDATION_COMMANDS,
  MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV,
  MCP_REPOSITORY_ROOT_ENV,
  createMcpServer,
} from "../src/mcp-server.js";

type RepositoryFixture = {
  root: string;
  repositoryPath: string;
};

const temporaryDirectories: string[] = [];

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

async function createRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "repository-inspector-root-"));
  const repositoryPath = join(root, "repository");
  temporaryDirectories.push(root);
  await mkdir(repositoryPath);

  git(repositoryPath, "init", "--initial-branch=main");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test User");
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({
    scripts: { test: "node -e \"process.stdout.write('validation ran')\"" },
  }));
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, "add", "base.txt", "package.json");
  git(repositoryPath, "commit", "-m", "Initial commit");

  git(repositoryPath, "switch", "--create", "feature");
  await writeFile(join(repositoryPath, "earlier-feature.txt"), "earlier\n");
  git(repositoryPath, "add", "earlier-feature.txt");
  git(repositoryPath, "commit", "-m", "Earlier feature commit");

  await writeFile(join(repositoryPath, "latest-feature.txt"), "latest\n");
  git(repositoryPath, "add", "latest-feature.txt");
  git(repositoryPath, "commit", "-m", "Latest feature commit");

  return { root, repositoryPath };
}

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-inspector-outside-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callReview(
  server: ReturnType<typeof createMcpServer>,
  arguments_: Record<string, unknown>,
) {
  const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return await client.callTool({ name: "review_repository", arguments: arguments_ });
  } finally {
    await client.close();
    await server.close();
  }
}

function errorText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected a standard MCP tool result.");
  }

  const text = result.content.find(isTextContent);
  if (!text) {
    throw new Error("Expected an MCP text result.");
  }
  return text.text;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("MCP server", () => {
  it("accepts the snake_case request within the configured root and runs an allowed command", async () => {
    const fixture = await createRepository();
    const server = createMcpServer({
      environment: { [MCP_REPOSITORY_ROOT_ENV]: fixture.root },
    });
    const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const reviewTool = tools.tools.find((tool) => tool.name === "review_repository");

      expect(reviewTool).toBeDefined();
      expect(reviewTool!.description).toContain(MCP_REPOSITORY_ROOT_ENV);
      expect(reviewTool!.description).toContain(DEFAULT_MCP_VALIDATION_COMMANDS.join(", "));
      expect(reviewTool!.inputSchema.properties).toMatchObject({
        repo_path: { type: "string" },
        base_ref: { type: "string" },
        validation_commands: { type: "array" },
      });
      expect(reviewTool!.inputSchema.properties).not.toHaveProperty("baseRef");
      expect(reviewTool!.inputSchema.properties).not.toHaveProperty("validationCommands");

      const result = await client.callTool({
        name: "review_repository",
        arguments: {
          repo_path: fixture.repositoryPath,
          base_ref: "HEAD~1",
          validation_commands: ["npm test"],
        },
      });
      const text = errorText(result);

      expect("isError" in result && result.isError).toBe(false);
      expect(text).toContain("latest-feature.txt (added)");
      expect(text).not.toContain("earlier-feature.txt (added)");
      expect(text).toContain("### npm test");
      expect(text).toContain("validation ran");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a non-allowlisted validation command before it can launch", async () => {
    const fixture = await createRepository();
    const marker = join(fixture.repositoryPath, "marker");
    const result = await callReview(
      createMcpServer({ environment: { [MCP_REPOSITORY_ROOT_ENV]: fixture.root } }),
      {
        repo_path: fixture.repositoryPath,
        validation_commands: [`touch "${marker}"`],
      },
    );

    expect("isError" in result && result.isError).toBe(true);
    expect(errorText(result)).toContain("Experimental MCP validation command is not permitted");
    expect(errorText(result)).toContain(DEFAULT_MCP_VALIDATION_COMMANDS.join(", "));
    expect(existsSync(marker)).toBe(false);
  });

  it("allows other shellless validation commands only with the explicit opt-in", async () => {
    const fixture = await createRepository();
    const result = await callReview(
      createMcpServer({
        environment: {
          [MCP_REPOSITORY_ROOT_ENV]: fixture.root,
          [MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV]: "1",
        },
      }),
      {
        repo_path: fixture.repositoryPath,
        validation_commands: [`node -e "process.stdout.write('broadened command ran')"`],
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(errorText(result)).toContain("broadened command ran");
  });

  it("rejects repository paths outside the configured root", async () => {
    const fixture = await createRepository();
    const outsideRepository = await createDirectory();
    const result = await callReview(
      createMcpServer({ environment: { [MCP_REPOSITORY_ROOT_ENV]: fixture.root } }),
      { repo_path: outsideRepository },
    );

    expect("isError" in result && result.isError).toBe(true);
    expect(errorText(result)).toContain("must resolve within");
  });

  it("rejects a symlink inside the configured root that resolves outside it", async () => {
    const fixture = await createRepository();
    const outsideRepository = await createDirectory();
    const escapedPath = join(fixture.root, "escaped-repository");
    await symlink(outsideRepository, escapedPath);

    const result = await callReview(
      createMcpServer({ environment: { [MCP_REPOSITORY_ROOT_ENV]: fixture.root } }),
      { repo_path: escapedPath },
    );

    expect("isError" in result && result.isError).toBe(true);
    expect(errorText(result)).toContain("must resolve within");
  });

  it("requires an explicit configured repository root", async () => {
    const fixture = await createRepository();
    const result = await callReview(createMcpServer({ environment: {} }), {
      repo_path: fixture.repositoryPath,
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(errorText(result)).toContain(`${MCP_REPOSITORY_ROOT_ENV} to be set`);
  });
});
