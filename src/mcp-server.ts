#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import type { ReviewRequest } from "./types.js";
import { tokenizeValidationCommand } from "./validation.js";

export const MCP_REPOSITORY_ROOT_ENV = "REPOSITORY_INSPECTOR_MCP_ROOT";
export const MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV =
  "REPOSITORY_INSPECTOR_MCP_ALLOW_ANY_VALIDATION_COMMANDS";
export const DEFAULT_MCP_VALIDATION_COMMANDS = [
  "npm test",
  "npm run typecheck",
  "npm run lint",
] as const;

export const mcpReviewRequestSchema = z.object({
  repo_path: z.string().describe("Repository path to inspect."),
  base_ref: z.string().optional(),
  validation_commands: z.array(z.string()).optional(),
});

export type McpReviewRequest = z.infer<typeof mcpReviewRequestSchema>;

type McpEnvironment = Record<string, string | undefined>;

type McpExecutionPolicy = {
  permittedRepositoryRoot: string;
  allowAnyValidationCommands: boolean;
};

export type McpServerOptions = {
  environment?: McpEnvironment;
};

export class McpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPolicyError";
  }
}

export function toReviewRequest(request: McpReviewRequest): ReviewRequest {
  return {
    repositoryPath: request.repo_path,
    baseRef: request.base_ref,
    validationCommands: request.validation_commands,
  };
}

function policyFromEnvironment(environment: McpEnvironment): McpExecutionPolicy {
  const configuredRoot = environment[MCP_REPOSITORY_ROOT_ENV]?.trim();
  if (!configuredRoot) {
    throw new McpPolicyError(
      `Experimental MCP requires ${MCP_REPOSITORY_ROOT_ENV} to be set to a permitted repository root.`,
    );
  }

  try {
    return {
      permittedRepositoryRoot: realpathSync(configuredRoot),
      allowAnyValidationCommands:
        environment[MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV] === "1",
    };
  } catch {
    throw new McpPolicyError(
      `Configured MCP repository root cannot be resolved: ${configuredRoot}.`,
    );
  }
}

function resolveRepositoryPath(repositoryPath: string): string {
  try {
    return realpathSync(repositoryPath);
  } catch {
    throw new McpPolicyError(
      `MCP repository path cannot be resolved: ${repositoryPath}.`,
    );
  }
}

function isWithinRoot(repositoryPath: string, permittedRoot: string): boolean {
  const pathFromRoot = relative(permittedRoot, repositoryPath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

/**
 * Applies the experimental MCP boundary before reviewRepository can launch Git
 * or any validation executable. The canonical path is used as the process cwd.
 */
export function validateMcpReviewRequest(
  request: ReviewRequest,
  environment: McpEnvironment = process.env,
): ReviewRequest {
  if (request.baseRef?.startsWith("-")) {
    throw new McpPolicyError('MCP base_ref must not begin with "-".');
  }

  const policy = policyFromEnvironment(environment);
  const repositoryPath = resolveRepositoryPath(request.repositoryPath);

  if (!isWithinRoot(repositoryPath, policy.permittedRepositoryRoot)) {
    throw new McpPolicyError(
      `MCP repository path must resolve within ${MCP_REPOSITORY_ROOT_ENV}: ${policy.permittedRepositoryRoot}.`,
    );
  }

  for (const command of request.validationCommands ?? []) {
    if (
      !policy.allowAnyValidationCommands &&
      !DEFAULT_MCP_VALIDATION_COMMANDS.includes(
        command as (typeof DEFAULT_MCP_VALIDATION_COMMANDS)[number],
      )
    ) {
      throw new McpPolicyError(
        `Experimental MCP validation command is not permitted: ${command}. Allowed commands: ${DEFAULT_MCP_VALIDATION_COMMANDS.join(", ")}. Set ${MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV}=1 to allow other shellless commands.`,
      );
    }
    tokenizeValidationCommand(command);
  }

  return { ...request, repositoryPath };
}

function policyDescription(): string {
  return [
    "Inspects a Git repository and returns a review report.",
    `Experimental MCP requires repo_path to resolve under ${MCP_REPOSITORY_ROOT_ENV}.`,
    `Validation commands must exactly match: ${DEFAULT_MCP_VALIDATION_COMMANDS.join(", ")}.`,
    `Set ${MCP_ALLOW_ANY_VALIDATION_COMMANDS_ENV}=1 to allow other shellless commands.`,
  ].join(" ");
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "repository-inspector", version: "2.0.0" });
  const environment = options.environment ?? process.env;

  server.tool(
    "review_repository",
    policyDescription(),
    mcpReviewRequestSchema.shape,
    async (input: McpReviewRequest) => {
      try {
        const request = validateMcpReviewRequest(toReviewRequest(input), environment);
        const report = await reviewRepository(request);
        return { content: [{ type: "text", text: report }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown MCP review failure.";
        return {
          content: [{ type: "text", text: `MCP review rejected: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
