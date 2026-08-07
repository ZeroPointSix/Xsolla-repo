#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import type { ReviewRequest } from "./types.js";

export const mcpReviewRequestSchema = z.object({
  repo_path: z.string().describe("Repository path to inspect."),
  base_ref: z.string().optional(),
  validation_commands: z.array(z.string()).optional(),
});

export type McpReviewRequest = z.infer<typeof mcpReviewRequestSchema>;

export function toReviewRequest(request: McpReviewRequest): ReviewRequest {
  return {
    repositoryPath: request.repo_path,
    baseRef: request.base_ref,
    validationCommands: request.validation_commands,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "repository-inspector", version: "2.0.0" });

  server.tool(
    "review_repository",
    "Inspects a Git repository and returns a review report.",
    mcpReviewRequestSchema.shape,
    async (input: McpReviewRequest) => {
      const report = await reviewRepository(toReviewRequest(input));
      return { content: [{ type: "text", text: report }] };
    },
  );

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}