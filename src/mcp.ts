import { realpathSync } from "node:fs";
import { delimiter as pathDelimiter, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import { markdownReport } from "./report.js";
import type { ReviewRequest } from "./schema.js";

const DEFAULT_ALLOWED_COMMANDS = [
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
];

export const mcpReviewInputSchema = z
  .object({
    repo_path: z.string().trim().min(1).describe("Repository path to inspect."),
    base_ref: z.string().trim().min(1).optional(),
    validation_commands: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    timeout_ms: z.number().int().positive().max(60_000).optional(),
    max_output_bytes: z.number().int().min(128).max(65_536).optional(),
  })
  .strict();

export const mcpReviewInputShape = mcpReviewInputSchema.shape;
export type McpReviewInput = z.infer<typeof mcpReviewInputSchema>;

function allowedCommands(environment: NodeJS.ProcessEnv): Set<string> {
  const configured = environment.INSPECTOR_MCP_ALLOWED_COMMANDS?.split(",")
    .map((command) => command.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_COMMANDS);
}

export function assertMcpCommandsAllowed(
  commands: string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const allowed = allowedCommands(environment);
  for (const command of commands) {
    if (!allowed.has(command.trim())) {
      throw new Error(
        `Validation command is not allowed by the MCP server: ${JSON.stringify(command)}`,
      );
    }
  }
}

function assertMcpRepositoryAllowed(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const canonicalRepository = realpathSync(repositoryPath);
  const configuredRoots = environment.INSPECTOR_MCP_ALLOWED_ROOTS?.split(pathDelimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const roots = configuredRoots?.length ? configuredRoots : [process.cwd()];

  const allowed = roots.some((root) => {
    const canonicalRoot = realpathSync(root);
    const fromRoot = relative(canonicalRoot, canonicalRepository);
    return (
      fromRoot === "" ||
      (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
    );
  });
  if (!allowed) {
    throw new Error(
      "Repository path is outside INSPECTOR_MCP_ALLOWED_ROOTS. Configure an allowed root explicitly.",
    );
  }
}

export function mapMcpInput(input: McpReviewInput): ReviewRequest {
  return {
    repositoryPath: input.repo_path,
    baseRef: input.base_ref,
    validationCommands: input.validation_commands ?? [],
  };
}

export function createMcpReviewHandler() {
  return async (rawInput: McpReviewInput) => {
    try {
      const input = mcpReviewInputSchema.parse(rawInput);
      const commands = input.validation_commands ?? [];
      assertMcpCommandsAllowed(commands);
      assertMcpRepositoryAllowed(input.repo_path);
      const result = await reviewRepository(mapMcpInput(input), {
        validationTimeoutMs: input.timeout_ms ?? 15_000,
        maxOutputBytes: input.max_output_bytes ?? 32_768,
      });
      return {
        content: [{ type: "text" as const, text: markdownReport(result) }],
        structuredContent: { ...result },
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  };
}
