import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "repository-inspector-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/mcp-server.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "review_repository",
    arguments: {
      repo_path: process.cwd(),
      base_ref: "HEAD",
    },
  });

  if (result.isError || result.structuredContent?.repository?.path !== process.cwd()) {
    throw new Error(`Unexpected MCP response: ${JSON.stringify(result)}`);
  }

  console.log("MCP stdio smoke check passed");
} finally {
  await client.close();
}
