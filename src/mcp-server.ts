#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpReviewHandler, mcpReviewInputShape } from "./mcp.js";
import { VERSION } from "./version.js";

const server = new McpServer({ name: "repository-inspector", version: VERSION });

server.tool(
  "review_repository",
  "Inspect a Git repository. Validation commands are restricted by the server allowlist.",
  mcpReviewInputShape,
  createMcpReviewHandler(),
);

await server.connect(new StdioServerTransport());
